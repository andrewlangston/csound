import * as Comlink from "comlink";
import { initFS, writeToFs, lsFs, llFs, readFromFs, rmrfFs } from "@root/filesystem";
import MessagePortState from "@utils/message-port-state";
import libcsoundFactory from "@root/libcsound";
import loadWasm from "@root/module";
import { logSABWorker as log } from "@root/logger";
import { handleCsoundStart } from "@root/workers/common.utils";
import { assoc, pipe } from "ramda";
import {
  AUDIO_STATE,
  MAX_HARDWARE_BUFFER_SIZE,
  MIDI_BUFFER_SIZE,
  MIDI_BUFFER_PAYLOAD_SIZE,
  initialSharedState,
} from "@root/constants.js";

let combined;
let pollPromise;

const callUncloned = async (k, arguments_) => {
  const caller = combined.get(k);
  const returnValue = caller && caller.apply({}, arguments_ || []);
  return returnValue;
};

const sabCreateRealtimeAudioThread = ({
  libraryCsound,
  callbacksRequest,
  wasm,
  wasmFs,
  workerMessagePort,
  watcherStdOut,
  watcherStdErr,
}) => ({ audioStateBuffer, audioStreamIn, audioStreamOut, midiBuffer, csound }) => {
  if (!watcherStdOut && !watcherStdErr) {
    [watcherStdOut, watcherStdErr] = initFS(wasmFs, workerMessagePort);
  }

  const audioStatePointer = new Int32Array(audioStateBuffer);

  // In case of multiple performances, let's reset the sab state
  initialSharedState.forEach((value, index) => {
    Atomics.store(audioStatePointer, index, value);
  });

  // Prompt for midi-input on demand
  const isRequestingRtMidiInput = libraryCsound._isRequestingRtMidiInput(csound);

  // Prompt for microphone only on demand!
  const isExpectingInput = libraryCsound.csoundGetInputName(csound).includes("adc");

  // Store Csound AudioParams for upcoming performance
  const nchnls = libraryCsound.csoundGetNchnls(csound);
  const nchnlsInput = isExpectingInput ? libraryCsound.csoundGetNchnlsInput(csound) : 0;
  const sampleRate = libraryCsound.csoundGetSr(csound);

  Atomics.store(audioStatePointer, AUDIO_STATE.NCHNLS, nchnls);
  Atomics.store(audioStatePointer, AUDIO_STATE.NCHNLS_I, nchnlsInput);
  Atomics.store(audioStatePointer, AUDIO_STATE.SAMPLE_RATE, sampleRate);
  Atomics.store(audioStatePointer, AUDIO_STATE.IS_REQUESTING_RTMIDI, isRequestingRtMidiInput);

  const ksmps = libraryCsound.csoundGetKsmps(csound);

  const zeroDecibelFullScale = libraryCsound.csoundGet0dBFS(csound);
  // Hardware buffer size
  const _B = Atomics.load(audioStatePointer, AUDIO_STATE.HW_BUFFER_SIZE);
  // Software buffer size
  const _b = Atomics.load(audioStatePointer, AUDIO_STATE.SW_BUFFER_SIZE);

  // Get the Worklet channels
  const channelsOutput = [];
  const channelsInput = [];
  for (let channelIndex = 0; channelIndex < nchnls; ++channelIndex) {
    channelsOutput.push(
      new Float64Array(
        audioStreamOut,
        MAX_HARDWARE_BUFFER_SIZE * channelIndex,
        MAX_HARDWARE_BUFFER_SIZE,
      ),
    );
  }

  for (let channelIndex = 0; channelIndex < nchnlsInput; ++channelIndex) {
    channelsInput.push(
      new Float64Array(
        audioStreamIn,
        MAX_HARDWARE_BUFFER_SIZE * channelIndex,
        MAX_HARDWARE_BUFFER_SIZE,
      ),
    );
  }

  // Let's notify the audio-worker that performance has started
  Atomics.store(audioStatePointer, AUDIO_STATE.IS_PERFORMING, 1);
  workerMessagePort.broadcastPlayState("realtimePerformanceStarted");
  log(
    `Atomic.wait started (thread is now locked)\n` +
      JSON.stringify({
        sr: sampleRate,
        ksmps: ksmps,
        nchnls_i: nchnlsInput,
        nchnls: nchnls,
        _B,
        _b,
      }),
  )();

  const performanceLoop = ({ lastReturn = 0, performanceEnded = false, firstRound = true }) => {
    if (firstRound) {
      // if after 1 minute the audioWorklet isn't ready, then something's very wrong
      Atomics.wait(audioStatePointer, AUDIO_STATE.ATOMIC_NOTIFY, 0, 60 * 1000);
      Atomics.and(audioStatePointer, AUDIO_STATE.ATOMIC_NOTIFY, 0);
      log(`Atomic.wait unlocked, performance started`)();
      return performanceLoop({ lastReturn, performanceEnded, firstRound: false });
    }
    if (
      Atomics.load(audioStatePointer, AUDIO_STATE.STOP) === 1 ||
      Atomics.load(audioStatePointer, AUDIO_STATE.IS_PERFORMING) !== 1 ||
      performanceEnded
    ) {
      log(
        `performance is ending possible culprits: STOP {}, IS_PERFORMING {}, performanceEnded {}`,
        audioStatePointer[AUDIO_STATE.STOP] === 1,
        audioStatePointer[AUDIO_STATE.IS_PERFORMING] !== 1,
        performanceEnded === 1,
      )();
      if (lastReturn === 0 && !performanceEnded) {
        log(`calling csoundStop and one performKsmps to trigger endof logs`)();
        // Trigger "performance ended" logs
        libraryCsound.csoundStop(csound);
        libraryCsound.csoundPerformKsmps(csound);
      }
      log(`triggering realtimePerformanceEnded event`)();
      workerMessagePort.broadcastPlayState("realtimePerformanceEnded");
      log(`End of realtimePerformance loop!`)();
      watcherStdOut && watcherStdOut.close();
      watcherStdOut = undefined;
      watcherStdErr && watcherStdErr.close();
      watcherStdErr = undefined;
      return;
    }

    if (Atomics.load(audioStatePointer, AUDIO_STATE.IS_PAUSED) === 1) {
      // eslint-disable-next-line no-unused-expressions
      Atomics.wait(audioStatePointer, AUDIO_STATE.IS_PAUSED, 0) === "ok";
    }

    if (isRequestingRtMidiInput) {
      const availableMidiEvents = Atomics.load(audioStatePointer, AUDIO_STATE.AVAIL_RTMIDI_EVENTS);
      if (availableMidiEvents > 0) {
        const rtmidiBufferIndex = Atomics.load(audioStatePointer, AUDIO_STATE.RTMIDI_INDEX);
        let absIndex = rtmidiBufferIndex;
        for (let index = 0; index < availableMidiEvents; index++) {
          // MIDI_BUFFER_PAYLOAD_SIZE
          absIndex = (rtmidiBufferIndex + MIDI_BUFFER_PAYLOAD_SIZE * index) % MIDI_BUFFER_SIZE;
          const status = Atomics.load(midiBuffer, absIndex);
          const data1 = Atomics.load(midiBuffer, absIndex + 1);
          const data2 = Atomics.load(midiBuffer, absIndex + 2);
          libraryCsound.csoundPushMidiMessage(csound, status, data1, data2);
        }

        Atomics.store(
          audioStatePointer,
          AUDIO_STATE.RTMIDI_INDEX,
          (absIndex + 1) % MIDI_BUFFER_SIZE,
        );
        Atomics.sub(audioStatePointer, AUDIO_STATE.AVAIL_RTMIDI_EVENTS, availableMidiEvents);
      }
    }

    const framesRequested = _b;

    const availableInputFrames = Atomics.load(audioStatePointer, AUDIO_STATE.AVAIL_IN_BUFS);

    const hasInput = availableInputFrames >= framesRequested;
    const inputBufferPtr = libraryCsound.csoundGetSpin(csound);
    const outputBufferPtr = libraryCsound.csoundGetSpout(csound);

    const csoundInputBuffer =
      hasInput && new Float64Array(wasm.exports.memory.buffer, inputBufferPtr, ksmps * nchnlsInput);

    const csoundOutputBuffer = new Float64Array(
      wasm.exports.memory.buffer,
      outputBufferPtr,
      ksmps * nchnls,
    );

    const inputReadIndex =
      hasInput && Atomics.load(audioStatePointer, AUDIO_STATE.INPUT_READ_INDEX);

    const outputWriteIndex = Atomics.load(audioStatePointer, AUDIO_STATE.OUTPUT_WRITE_INDEX);

    for (let index = 0; index < framesRequested; index++) {
      const currentInputReadIndex = hasInput && (inputReadIndex + index) % _B;
      const currentOutputWriteIndex = (outputWriteIndex + index) % _B;

      const currentCsoundInputBufferPos = hasInput && currentInputReadIndex % ksmps;
      const currentCsoundOutputBufferPos = currentOutputWriteIndex % ksmps;

      if (currentCsoundOutputBufferPos === 0 && !performanceEnded) {
        if (lastReturn === 0) {
          lastReturn = libraryCsound.csoundPerformKsmps(csound);
        } else {
          performanceEnded = true;
        }
      }

      channelsOutput.forEach((channel, channelIndex) => {
        channel[currentOutputWriteIndex] =
          (csoundOutputBuffer[currentCsoundOutputBufferPos * nchnls + channelIndex] || 0) /
          zeroDecibelFullScale;
      });

      if (hasInput) {
        channelsInput.forEach((channel, channelIndex) => {
          csoundInputBuffer[currentCsoundInputBufferPos * nchnlsInput + channelIndex] =
            (channel[currentInputReadIndex] || 0) * zeroDecibelFullScale;
        });

        Atomics.add(audioStatePointer, AUDIO_STATE.INPUT_READ_INDEX, 1);

        if (Atomics.load(audioStatePointer, AUDIO_STATE.INPUT_READ_INDEX) >= _B) {
          Atomics.store(audioStatePointer, AUDIO_STATE.INPUT_READ_INDEX, 0);
        }
      }

      Atomics.add(audioStatePointer, AUDIO_STATE.OUTPUT_WRITE_INDEX, 1);

      if (Atomics.load(audioStatePointer, AUDIO_STATE.OUTPUT_WRITE_INDEX) >= _B) {
        Atomics.store(audioStatePointer, AUDIO_STATE.OUTPUT_WRITE_INDEX, 0);
      }
    }

    // only decrease available input buffers if
    // they were actually consumed
    hasInput && Atomics.sub(audioStatePointer, AUDIO_STATE.AVAIL_IN_BUFS, framesRequested);
    Atomics.add(audioStatePointer, AUDIO_STATE.AVAIL_OUT_BUFS, framesRequested);

    if (Atomics.compareExchange(audioStatePointer, AUDIO_STATE.HAS_PENDING_CALLBACKS, 1, 0) === 1) {
      new Promise((resolve) => {
        pollPromise = resolve;
        callbacksRequest();
      }).then(() => {
        Atomics.wait(audioStatePointer, AUDIO_STATE.ATOMIC_NOTIFY, 0);
        Atomics.store(audioStatePointer, AUDIO_STATE.ATOMIC_NOTIFY, 0);
        return performanceLoop({ lastReturn, performanceEnded, firstRound });
      });
    } else {
      Atomics.wait(audioStatePointer, AUDIO_STATE.ATOMIC_NOTIFY, 0);
      Atomics.store(audioStatePointer, AUDIO_STATE.ATOMIC_NOTIFY, 0);
      return performanceLoop({ lastReturn, performanceEnded, firstRound });
    }
  };
  return performanceLoop({});
};

const initMessagePort = ({ port }) => {
  const workerMessagePort = new MessagePortState();
  workerMessagePort.post = (messageLog) => port.postMessage({ log: messageLog });
  workerMessagePort.broadcastPlayState = (playStateChange) => port.postMessage({ playStateChange });
  workerMessagePort.ready = true;
  return workerMessagePort;
};

const initCallbackReplyPort = ({ port }) => {
  port.addEventListener("message", (event) => {
    const callbacks = event.data;
    const answers = callbacks.reduce((accumulator, { id, argumentz, apiKey }) => {
      try {
        const caller = combined.get(apiKey);
        const answer = caller && caller.apply({}, argumentz || []);
        accumulator.push({ id, answer });
      } catch (error) {
        throw new Error(error);
      }
      return accumulator;
    }, []);
    port.postMessage(answers);
    const donePromise = pollPromise;
    pollPromise = undefined;
    donePromise && donePromise(callbacks);
  });
  port.start();
};

const renderFunction = ({
  libraryCsound,
  callbacksRequest,
  workerMessagePort,
  wasmFs,
  watcherStdOut,
  watcherStdErr,
}) => async ({ audioStateBuffer, csound }) => {
  if (!watcherStdOut && !watcherStdErr) {
    [watcherStdOut, watcherStdErr] = initFS(wasmFs, workerMessagePort);
  }

  const audioStatePointer = new Int32Array(audioStateBuffer);
  Atomics.store(audioStatePointer, AUDIO_STATE.IS_PERFORMING, 1);
  while (
    Atomics.load(audioStatePointer, AUDIO_STATE.STOP) !== 1 &&
    libraryCsound.csoundPerformKsmps(csound) === 0
  ) {
    if (Atomics.load(audioStatePointer, AUDIO_STATE.IS_PAUSED) === 1) {
      // eslint-disable-next-line no-unused-expressions
      Atomics.wait(audioStatePointer, AUDIO_STATE.IS_PAUSED, 0) === "ok";
    }
    if (Atomics.compareExchange(audioStatePointer, AUDIO_STATE.HAS_PENDING_CALLBACKS, 1, 0) === 1) {
      await new Promise((resolve) => {
        pollPromise = resolve;
        callbacksRequest();
      });
    }
  }
  Atomics.store(audioStatePointer, AUDIO_STATE.IS_PERFORMING, 0);
  workerMessagePort.broadcastPlayState("renderEnded");
  watcherStdOut && watcherStdOut.close();
  watcherStdOut = undefined;
  watcherStdErr && watcherStdErr.close();
  watcherStdErr = undefined;
};

const initialize = async ({ wasmDataURI, withPlugins = [], messagePort, callbackPort }) => {
  log(`initializing SABWorker and WASM`)();
  const workerMessagePort = initMessagePort({ port: messagePort });
  const callbacksRequest = () => callbackPort.postMessage("poll");
  initCallbackReplyPort({ port: callbackPort });
  const [wasm, wasmFs] = await loadWasm({
    wasmDataURI,
    withPlugins,
    messagePort: workerMessagePort,
  });

  const [watcherStdOut, watcherStdError] = initFS(wasmFs, workerMessagePort);
  const libraryCsound = libcsoundFactory(wasm);

  const startHandler = handleCsoundStart(
    workerMessagePort,
    libraryCsound,
    sabCreateRealtimeAudioThread({
      libraryCsound,
      callbacksRequest,
      wasm,
      wasmFs,
      workerMessagePort,
      watcherStdOut,
      watcherStdErr: watcherStdError,
    }),
    renderFunction({
      libraryCsound,
      callbacksRequest,
      workerMessagePort,
      watcherStdOut,
      watcherStdErr: watcherStdError,
    }),
  );

  const allAPI = pipe(
    assoc("writeToFs", writeToFs(wasmFs)),
    assoc("readFromFs", readFromFs(wasmFs)),
    assoc("lsFs", lsFs(wasmFs)),
    assoc("llFs", llFs(wasmFs)),
    assoc("rmrfFs", rmrfFs(wasmFs)),
    assoc("csoundStart", startHandler),
    assoc("wasm", wasm),
  )(libraryCsound);
  combined = new Map(Object.entries(allAPI));

  libraryCsound.csoundInitialize(0);
  const csoundInstance = libraryCsound.csoundCreate();
  return csoundInstance;
};

Comlink.expose({ initialize, callUncloned });
