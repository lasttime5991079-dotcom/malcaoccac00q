'use strict';

const { existsSync } = require('node:fs');
const { isAbsolute, join } = require('node:path');
const { performance } = require('node:perf_hooks');
const { setTimeout: delay } = require('node:timers/promises');
const puppeteer = require('puppeteer-core');

const qualities = {
  'Original (1080p Max)': [1920, 1080, 6000],
  '1080p': [1920, 1080, 4500],
  '720p': [1280, 720, 3000],
  '480p': [854, 480, 1500],
  '360p': [640, 360, 800],
};
const timing = { navigation: 20_000, startup: 35_000, poll: 1_000, cooldown: 15_000 };
const mediaErrors = {
  2: 'video network error',
  3: 'video decode error',
  4: 'unsupported video source or codec',
};

class BotError extends Error {}

function loadStreamKeys(env) {
  const configuredPath = env.STREAM_KEYS_FILE?.trim();
  if (configuredPath && !isAbsolute(configuredPath)) {
    throw new BotError('STREAM_KEYS_FILE must be an absolute path to a private JavaScript file.');
  }
  const file = configuredPath || join(__dirname, 'stream-keys.js');
  if (!configuredPath && !existsSync(file)) return {};
  try {
    const credentials = require(file);
    if (!credentials || typeof credentials !== 'object') throw new Error();
    return credentials;
  } catch {
    throw new BotError('Could not load the JavaScript stream-key file. Check its path and module.exports.');
  }
}

function readSettings(env) {
  const targets = new Map();
  for (const entry of (env.TARGET_URLS ?? '').split(',')) {
    const item = entry.trim();
    if (!item) continue;
    const extended = item.startsWith('!');
    const address = extended ? item.slice(1).trim() : item;
    const number = targets.size + 1;
    let url;
    try {
      url = new URL(address);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error();
    } catch {
      throw new BotError(`Source ${number} requires a valid HTTP(S) URL without embedded credentials.`);
    }
    if (!targets.has(url.href)) {
      targets.set(url.href, { number, url: url.href, stallMs: extended ? 25_000 : 12_000 });
    }
  }
  if (!targets.size) throw new BotError('Provide at least one source URL in TARGET_URLS.');

  const duration = (env.CUSTOM_DURATION || 'None').trim();
  const parts = /^(?:(\d+)\s*h)?\s*(?:(\d+)\s*m)?$/i.exec(duration);
  const minutes = parts && Number(parts[1] ?? 0) * 60 + Number(parts[2] ?? 0);
  if (!/^none$/i.test(duration) && (!minutes || minutes > 7195)) {
    throw new BotError('CUSTOM_DURATION must be None or a duration of up to 119h 55m, such as 4h 30m.');
  }

  const quality = env.STREAM_QUALITY || 'Original (1080p Max)';
  if (!Object.hasOwn(qualities, quality)) throw new BotError('Select a supported STREAM_QUALITY.');
  const [width, height, bitrate] = qualities[quality];
  const serverSelector = (env.SERVER_SELECTOR || '').trim();
  const channel = (env.OKRU_STREAM_ID || '1').trim();
  if (!/^[1-8]$/.test(channel)) throw new BotError('OKRU_STREAM_ID must be a channel from 1 to 8.');
  const ingestOverride = env.STREAM_INGEST_URL?.trim();
  const keyOverride = env.STREAM_KEY?.trim();
  const credentials = ingestOverride && keyOverride ? {} : loadStreamKeys(env);
  const ingestUrl = ingestOverride || credentials.ingestUrl;
  const streamKey = keyOverride || credentials.keys?.[channel];
  if (typeof ingestUrl !== 'string' || !/^rtmps?:\/\/[^\s]+$/i.test(ingestUrl.trim()) ||
      typeof streamKey !== 'string' || !streamKey.trim()) {
    throw new BotError(`Configure the ingest URL and channel ${channel} key in stream-keys.js or the runner environment.`);
  }
  return {
    sources: [...targets.values()], width, height, bitrate, ingestUrl: ingestUrl.trim(), streamKey: streamKey.trim(),
    durationMs: /^none$/i.test(duration) ? 0 : minutes * 60_000,
    videoSelector: (env.VIDEO_SELECTOR || '').trim() || 'video',
    serverSelector: /^none$/i.test(serverSelector) ? '' : serverSelector,
  };
}

async function selectServer(page, selector, signal, timings) {
  if (!selector) return;
  const deadline = performance.now() + Math.min(8_000, timings.startup / 2);
  while (performance.now() < deadline) {
    for (const frame of page.frames()) {
      signal.throwIfAborted();
      const clicked = await frame.isolatedRealm().evaluate((css) => {
        const control = document.querySelector(css);
        if (control && control.getClientRects().length && !control.matches(':disabled')) {
          control.click();
          return true;
        }
        return false;
      }, selector).catch(() => false);
      if (clicked) return;
    }
    await delay(timings.poll, undefined, { signal });
  }
}

async function inspectPlayer(page, selector) {
  const snapshots = await Promise.all(page.frames().map(async (frame) => {
    const observation = await frame.isolatedRealm().evaluate((css) => {
      const monitor = globalThis.streamVideoMonitor ??= { ids: new WeakMap(), play: new WeakMap(), nextId: 0 };
      const candidates = [...document.querySelectorAll(css)].filter((el) => el instanceof HTMLVideoElement);
      let player;
      for (const video of candidates) {
        const rect = video.getBoundingClientRect();
        const style = getComputedStyle(video);
        if (style.visibility !== 'visible' || Number(style.opacity) === 0 ||
            rect.bottom <= 0 || rect.right <= 0 || rect.top >= innerHeight || rect.left >= innerWidth) continue;
        const area = rect.width * rect.height;
        if (!area || area <= (player?.area ?? 0)) continue;
        if (!monitor.ids.has(video)) monitor.ids.set(video, ++monitor.nextId);
        const quality = video.getVideoPlaybackQuality();
        player = {
          id: monitor.ids.get(video),
          area,
          time: video.currentTime,
          frames: quality.totalVideoFrames - quality.droppedVideoFrames,
          paused: video.paused,
          ended: video.ended,
          advancing: !video.paused && !video.ended && !video.seeking && video.readyState >= 2,
          ready: video.readyState >= 1,
          error: video.error?.code ?? 0,
          playError: monitor.play.get(video)?.error,
        };
      }
      const alerts = [...document.querySelectorAll('.jw-error-msg, [role="alert"]')]
        .filter((el) => el.getClientRects().length && getComputedStyle(el).visibility === 'visible');
      const playerText = alerts.map((el) => el.innerText).join(' ');
      const text = (playerText || document.body?.innerText || '').replace(/\s+/g, ' ');
      const code = text.match(/\berror\s+code\s*:?\s*(\d{6,8})\b/i)?.[1];
      let notice;
      if (/there was a problem providing access to protected content/i.test(text)) {
        notice = { reason: 'player reported a protected-content access error', code, blocked: true };
      } else if (/\b(?:this )?domain is blocked\b/i.test(text)) {
        notice = { reason: 'player reported a domain access restriction', code, blocked: true };
      } else if (/problem with your internet connection|live stream is either down or has ended|error loading media|\bstream unavailable\b|the video cannot be played in this browser/i.test(text) ||
          (playerText && /\bplayback error\b/i.test(text))) {
        notice = { reason: 'player reported a playback or connection error', code };
      }
      return { player, notice };
    }, selector).catch(() => null);
    return { frame, ...observation };
  }));
  if (!page.browser().connected || page.isClosed()) throw new BotError('Chrome control was lost.');
  const best = snapshots.reduce((a, b) => (b.player?.area ?? 0) > (a?.player.area ?? 0) ? b : a, null);
  const mainNotice = snapshots.find((snapshot) => snapshot.frame === page.mainFrame())?.notice;
  const notice = best?.notice || mainNotice || (!best && snapshots.find((snapshot) => snapshot.notice)?.notice);
  return { notice, best };
}

function progressed(previous, next) {
  return previous && next && previous.frame === next.frame && previous.player.id === next.player.id &&
    next.player.advancing && next.player.frames > previous.player.frames &&
    next.player.time - previous.player.time >= 0.10;
}

async function controlPlayer({ frame, player }, selector, action) {
  await frame.isolatedRealm().evaluate((css, id, control) => {
    for (const el of document.querySelectorAll(css)) {
      if (globalThis.streamVideoMonitor?.ids.get(el) === id) {
        if (control === 'play') {
          const attempts = globalThis.streamVideoMonitor.play;
          const previous = attempts.get(el);
          if (previous?.inFlight || (previous && Date.now() - previous.at < 3_000)) break;
          const attempt = { at: Date.now(), inFlight: true };
          attempts.set(el, attempt);
          void el.play().catch((error) => {
            if (['NotAllowedError', 'NotSupportedError'].includes(error.name)) attempt.error = error.name;
          }).finally(() => { attempt.inFlight = false; });
        }
        if (control === 'present') {
          el.muted = false;
          if (el.volume === 0) el.volume = 1;
          if (document.fullscreenEnabled && !document.fullscreenElement) {
            void el.requestFullscreen().catch(() => {});
          }
        }
        break;
      }
    }
  }, selector, player.id, action).catch(() => {});
}

async function watchSource(page, source, config, showLive, signal, timings) {
  let response;
  try {
    response = await page.goto(source.url, { waitUntil: 'domcontentloaded', timeout: timings.navigation });
  } catch {
    signal.throwIfAborted();
    if (!page.browser().connected || page.isClosed()) throw new BotError('Chrome control was lost.');
    return { reason: 'navigation failed or timed out' };
  }

  const status = response?.status();
  if ([401, 403, 451].includes(status)) return { reason: `page returned HTTP ${status}`, blocked: true };
  if (status >= 400) return { reason: `page returned HTTP ${status}` };

  const startupDeadline = performance.now() + timings.startup;
  let previous;
  let live = false;
  let goodSamples = 0;
  let previousFailure;
  let lastAdvance = performance.now();
  for (;;) {
    signal.throwIfAborted();
    const { best, notice } = await inspectPlayer(page, config.videoSelector);
    signal.throwIfAborted();
    if (notice?.blocked) {
      const detail = notice.code ? ` (player code ${notice.code})` : '';
      return { live, reason: `${notice.reason}${detail}`, blocked: true };
    }
    if (!previous && !live && config.serverSelector) {
      await selectServer(page, config.serverSelector, signal, timings);
      config = { ...config, serverSelector: '' };
      continue;
    }

    const now = performance.now();
    const player = best?.player;
    if (progressed(previous, best)) {
      lastAdvance = now;
      goodSamples++;
      previousFailure = undefined;
    } else {
      goodSamples = 0;
      const reported = notice && `${notice.reason}${notice.code ? ` (player code ${notice.code})` : ''}`;
      const failure = player?.ended ? 'video ended' : mediaErrors[player?.error] || reported;
      if (failure && failure === previousFailure) return { live, reason: failure };
      previousFailure = failure;
      if (player?.paused && player.ready && !player.ended && !player.error) {
        await controlPlayer(best, config.videoSelector, 'play');
      }
    }
    previous = best;

    if (!live && goodSamples >= 2) {
      await controlPlayer(best, config.videoSelector, 'present');
      signal.throwIfAborted();
      await showLive(true);
      console.log(`[Source ${source.number}] Playing. OBS is on the live scene.`);
      live = true;
    }
    if (!live && now >= startupDeadline) {
      const detail = player?.playError === 'NotAllowedError' ? 'browser denied autoplay' :
        player?.playError === 'NotSupportedError' ? 'unsupported video source or codec' :
        player ? 'video did not advance' : 'no matching visible video';
      return { reason: `startup timed out (${detail})` };
    }
    if (live && now - lastAdvance >= source.stallMs) return { live, reason: 'video stalled' };
    await delay(timings.poll, undefined, { signal });
  }
}

async function runSources({ page, config, showLive, signal, timings = timing }) {
  const skipped = new Set();
  let cooldown = timings.cooldown;
  for (const selector of [config.videoSelector, config.serverSelector].filter(Boolean)) {
    const valid = await page.evaluate((css) => {
      try {
        document.querySelector(css);
        return true;
      } catch {
        return false;
      }
    }, selector);
    if (!valid) throw new BotError('VIDEO_SELECTOR and SERVER_SELECTOR must be valid CSS selectors.');
  }

  for (;;) {
    for (const source of config.sources) {
      signal.throwIfAborted();
      if (skipped.has(source.number)) continue;
      console.log(`[Source ${source.number}] Checking playback.`);
      const outcome = await watchSource(page, source, config, showLive, signal, timings);
      if (outcome.live || outcome.blocked) await showLive(false);
      await page.goto('about:blank', { waitUntil: 'domcontentloaded', timeout: timings.navigation })
        .catch(() => { throw new BotError('The failed page could not be cleared.'); });
      if (outcome.live) cooldown = timings.cooldown;
      if (outcome.blocked) skipped.add(source.number);
      console.warn(`[Source ${source.number}] ${outcome.reason}${outcome.blocked ? '. Skipping for this run' : ''}.`);
    }

    if (skipped.size === config.sources.length) throw new BotError('All configured sources reported access errors.');
    console.log(`End of source list. Retrying in ${Math.round(cooldown / 1000)} seconds.`);
    await delay(cooldown, undefined, { signal });
    cooldown = Math.min(cooldown * 2, 120_000);
  }
}

async function main() {
  const { createObs } = require('./obs');
  const config = readSettings(process.env);
  delete process.env.STREAM_KEY;
  delete process.env.STREAM_INGEST_URL;
  delete process.env.TARGET_URLS;
  delete process.env.STREAM_KEYS_FILE;
  if (!process.env.DISPLAY) throw new BotError('An X11 display is required. Run inside Xvfb.');
  const stop = new AbortController();
  const requestStop = () => stop.abort();
  process.once('SIGINT', requestStop);
  process.once('SIGTERM', requestStop);
  const timer = config.durationMs ? setTimeout(requestStop, config.durationMs) : undefined;
  let obs;
  let browser;
  let infrastructureError;
  const fail = (error) => {
    if (!stop.signal.aborted) infrastructureError = error;
    stop.abort();
  };

  try {
    obs = await createObs({ ...config, signal: stop.signal });
    obs.failure.catch(fail);
    stop.signal.throwIfAborted();
    browser = await puppeteer.launch({
      executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome',
      headless: false,
      defaultViewport: null,
      handleSIGINT: false,
      handleSIGTERM: false,
      handleSIGHUP: false,
      ignoreDefaultArgs: ['--disable-popup-blocking', '--disable-component-update'],
      protocolTimeout: 8_000,
      args: ['--kiosk', '--window-position=0,0', '--window-size=1920,1080',
        '--autoplay-policy=no-user-gesture-required', '--no-first-run'],
    }).catch(() => { throw new BotError('Chrome did not start. Check CHROME_PATH and the runner’s Chrome sandbox.'); });
    browser.once('disconnected', () => fail(new BotError('Chrome disconnected.')));
    stop.signal.throwIfAborted();
    const [page, ...extraPages] = await browser.pages();
    if (!page) throw new BotError('Chrome started without a player tab.');
    await Promise.all(extraPages.map((extra) => extra.close()));
    page.on('popup', (popup) => { void popup.close().catch(() => {}); });
    page.on('dialog', (dialog) => { void dialog.dismiss().catch(() => {}); });
    page.once('error', () => fail(new BotError('The Chrome player tab crashed.')));
    await page.bringToFront();
    await runSources({ page, config, showLive: obs.showLive, signal: stop.signal });
  } catch (error) {
    if (infrastructureError) throw infrastructureError;
    if (!stop.signal.aborted) throw error;
  } finally {
    stop.abort();
    clearTimeout(timer);
    try {
      await obs?.close();
    } finally {
      await browser?.close().catch(() => {});
    }
    process.off('SIGINT', requestStop);
    process.off('SIGTERM', requestStop);
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error instanceof BotError || error.name === 'ObsError' ? error.message : 'The stream bot stopped because of an unexpected error.');
    process.exitCode = 1;
  });
}

module.exports = { readSettings, runSources };
