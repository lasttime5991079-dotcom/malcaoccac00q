'use strict';

const { spawn } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const { mkdir, mkdtemp, rm, writeFile } = require('node:fs/promises');
const { createServer } = require('node:net');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { setTimeout: sleep } = require('node:timers/promises');
const { OBSWebSocket } = require('obs-websocket-js/json');

const COLLECTION = 'Stream Bot';
const CONFIG_NAME = 'StreamBot';
const WAITING = 'Waiting';
const LIVE = 'Live';
const BASE_WIDTH = 1920;
const BASE_HEIGHT = 1080;

class ObsError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ObsError';
  }
}

function allocatePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

async function within(promise, ms, message) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms);
    })]);
  } finally {
    clearTimeout(timer);
  }
}

async function writeConfig(root, { width, height, bitrate, ingestUrl, streamKey }, port, password) {
  const obsRoot = join(root, 'obs-studio');
  const profileDir = join(obsRoot, 'basic', 'profiles', CONFIG_NAME);
  const sceneDir = join(obsRoot, 'basic', 'scenes');
  await Promise.all([mkdir(profileDir, { recursive: true }), mkdir(sceneDir, { recursive: true })]);

  const frontendIni = `[General]\nLanguage=en-US\nFirstRun=true\n` +
    `[Basic]\nProfile=${COLLECTION}\nProfileDir=${CONFIG_NAME}\nSceneCollection=${COLLECTION}\nSceneCollectionFile=${CONFIG_NAME}\n` +
    '[BasicWindow]\nPreviewEnabled=false\n';
  const websocketIni = '[OBSWebSocket]\nFirstLoad=false\nServerEnabled=true\nAuthRequired=true\n' +
    `AlertsEnabled=false\nServerPort=${port}\nServerPassword=${password}\n`;
  const profileIni = `[General]\nName=${COLLECTION}\n[Output]\nMode=Simple\n` +
    `[Video]\nBaseCX=${BASE_WIDTH}\nBaseCY=${BASE_HEIGHT}\nOutputCX=${width}\nOutputCY=${height}\nFPSCommon=30\n` +
    `[SimpleOutput]\nVBitrate=${bitrate}\nABitrate=160\nStreamEncoder=x264\nPreset=veryfast\nUseAdvanced=true\nx264Settings=keyint=60\n`;
  const service = { type: 'rtmp_custom', settings: { server: ingestUrl, key: streamKey } };
  const collection = {
    name: COLLECTION,
    current_scene: WAITING,
    current_program_scene: WAITING,
    scene_order: [{ name: WAITING }],
    sources: [{ name: WAITING, id: 'scene', versioned_id: 'scene', settings: { items: [] } }],
    current_transition: 'Cut',
  };
  const privateFile = { mode: 0o600 };
  await Promise.all([
    writeFile(join(obsRoot, 'global.ini'), frontendIni + websocketIni, privateFile),
    writeFile(join(obsRoot, 'user.ini'), frontendIni, privateFile),
    writeFile(join(profileDir, 'basic.ini'), profileIni, privateFile),
    writeFile(join(profileDir, 'service.json'), JSON.stringify(service), privateFile),
    writeFile(join(sceneDir, `${CONFIG_NAME}.json`), JSON.stringify(collection), privateFile),
  ]);
}

async function createObs({ width, height, bitrate, ingestUrl, streamKey, signal }) {
  if (!process.env.DISPLAY || !process.env.PULSE_SINK) {
    throw new ObsError('OBS requires a dedicated X11 DISPLAY and PulseAudio PULSE_SINK.');
  }

  signal?.throwIfAborted();
  const root = await mkdtemp(join(tmpdir(), 'stream-obs-'));
  const obs = new OBSWebSocket();
  const lifetime = new AbortController();
  const startupSignal = signal ? AbortSignal.any([signal, lifetime.signal]) : lifetime.signal;
  let child;
  let childClosed;
  let startup;
  let closePromise;
  let outputStarted = false;
  let rejectFailure;
  const failure = new Promise((_, reject) => { rejectFailure = reject; });
  failure.catch(() => {});

  function fail(message) {
    if (!closePromise) rejectFailure(new ObsError(message));
  }

  async function call(name, data) {
    try {
      return await within(obs.call(name, data), 5000, 'OBS request timed out.');
    } catch (error) {
      const code = Number.isInteger(error.code) ? ` (code ${error.code})` : '';
      throw new ObsError(`OBS ${name} failed${code}.`);
    }
  }

  async function cleanup() {
    lifetime.abort();
    if (obs.identified && outputStarted) await call('StopStream').catch(() => {});
    await within(obs.disconnect(), 2000, 'OBS disconnect timed out.').catch(() => {});
    if (child?.pid && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      try {
        await within(childClosed, 5000, 'OBS shutdown timed out.');
      } catch {
        child.kill('SIGKILL');
        await childClosed;
      }
    }
    await startup?.catch(() => {});
    await rm(root, { recursive: true, force: true });
  }

  function close() {
    closePromise ??= Promise.resolve().then(cleanup);
    return closePromise;
  }

  async function showLive(live) {
    await call('SetCurrentProgramScene', { sceneName: live ? LIVE : WAITING });
  }

  async function start(port, password) {
    const env = { ...process.env, XDG_CONFIG_HOME: root, QT_QPA_PLATFORM: 'xcb' };
    delete env.STREAM_KEY;
    delete env.STREAM_INGEST_URL;
    delete env.TARGET_URLS;
    child = spawn('obs', [
      '--multi', '--minimize-to-tray', '--disable-missing-files-check',
      '--profile', COLLECTION, '--collection', COLLECTION,
    ], { env, stdio: 'ignore' });
    childClosed = new Promise((resolve) => child.once('close', resolve));
    child.once('error', () => fail('OBS could not start. Install OBS Studio with obs-websocket v5 on the runner.'));
    child.once('exit', (code, reason) => fail(`OBS exited unexpectedly (${reason ?? code}).`));

    const connectionDeadline = performance.now() + 30000;
    while (true) {
      startupSignal.throwIfAborted();
      try {
        await within(obs.connect(`ws://127.0.0.1:${port}`, password, { rpcVersion: 1 }), 5000, 'OBS connection timed out.');
        await call('GetVersion');
        break;
      } catch {
        await within(obs.disconnect(), 2000, 'OBS disconnect timed out.').catch(() => {});
        if (performance.now() >= connectionDeadline) throw new ObsError('OBS WebSocket did not become ready. Check that OBS starts on the Xvfb display.');
        await sleep(400, undefined, { signal: startupSignal });
      }
    }

    obs.on('ConnectionClosed', () => fail('OBS WebSocket connection closed unexpectedly.'));
    obs.on('StreamStateChanged', ({ outputState }) => {
      if (outputState === 'OBS_WEBSOCKET_OUTPUT_STARTED') outputStarted = true;
      if (outputStarted && outputState === 'OBS_WEBSOCKET_OUTPUT_STOPPED') fail('OBS stream output stopped. Check the destination and ingest credentials.');
    });

    const settings = await call('GetVideoSettings');
    if (settings.baseWidth !== BASE_WIDTH || settings.baseHeight !== BASE_HEIGHT ||
        settings.outputWidth !== width || settings.outputHeight !== height) {
      throw new ObsError('OBS started with unexpected video settings. Check the selected profile.');
    }

    const { inputKinds } = await call('GetInputKindList');
    const displayKind = inputKinds.includes('xshm_input_v2') ? 'xshm_input_v2' : 'xshm_input';
    if (!inputKinds.includes(displayKind) || !inputKinds.includes('pulse_output_capture')) {
      throw new ObsError('OBS must include the Linux XSHM and PulseAudio capture plugins.');
    }

    await call('CreateScene', { sceneName: LIVE });
    await call('CreateInput', {
      sceneName: LIVE, inputName: 'Chrome Display', inputKind: displayKind,
      inputSettings: { screen: 0, show_cursor: false }, sceneItemEnabled: true,
    });
    await call('CreateInput', {
      sceneName: LIVE, inputName: 'Chrome Audio', inputKind: 'pulse_output_capture',
      inputSettings: { device_id: `${process.env.PULSE_SINK}.monitor` }, sceneItemEnabled: true,
    });
    await call('SetCurrentSceneTransition', { transitionName: 'Cut' });
    await showLive(false);
    startupSignal.throwIfAborted();
    await call('StartStream');

    const outputDeadline = performance.now() + 25000;
    do {
      startupSignal.throwIfAborted();
      const status = await call('GetStreamStatus');
      if (status.outputActive && !status.outputReconnecting && status.outputBytes > 0) {
        outputStarted = true;
        return;
      }
      await sleep(500, undefined, { signal: startupSignal });
    } while (performance.now() < outputDeadline);
    throw new ObsError('OBS did not confirm bytes sent to the ingest destination. Check the ingest address and credentials.');
  }

  try {
    const port = await allocatePort();
    const password = randomBytes(24).toString('hex');
    await writeConfig(root, { width, height, bitrate, ingestUrl, streamKey }, port, password);
    startupSignal.throwIfAborted();
    startup = start(port, password);
    await Promise.race([startup, failure]);
    return { showLive, close, failure };
  } catch (error) {
    await close();
    throw error;
  }
}

module.exports = { createObs };
