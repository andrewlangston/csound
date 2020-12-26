// import TextEncoderShim from 'text-encoding-shim';

const sizeOf = {
  int: 4,
  MYFLT: 4,
  char: 1,
};

export const decoder = new TextDecoder("utf-8");
export const encoder = new TextEncoder("utf-8");

export const uint2String = (uint) => decoder.decode(uint);

export const trimNull = (a) => {
  const c = a.indexOf("\0");
  if (c > -1) {
    // eslint-disable-next-line unicorn/prefer-string-slice
    return a.substr(0, c);
  }
  return a;
};

// eslint-disable-next-line no-unused-vars
export const cleanStdout = (stdout) => {
  const pattern = [
    "[\\u001B\\u009B][[\\]()#;?]*(?:(?:(?:[a-zA-Z\\d]*(?:;[-a-zA-Z\\d\\/#&.:=?%@~_]*)*)?\\u0007)",
    "(?:(?:\\d{1,4}(?:;\\d{0,4})*)?[\\dA-PR-TZcf-ntqry=><~]))",
  ].join("|");
  const regexPattern = new RegExp(pattern, "g");
  return stdout.replace(regexPattern, "");
};

export const string2ptr = (wasm, string) => {
  if (typeof string !== "string") {
    console.error("Expected string but got", typeof string);
    return;
  }

  const stringBuf = encoder.encode(string);
  const offset = wasm.exports.allocStringMem(stringBuf.length);
  const { buffer } = wasm.exports.memory;
  const outBuf = new Uint8Array(buffer, offset, stringBuf.length + 1);
  outBuf.set(stringBuf);
  return offset;
};

export const ptr2string = (wasm, stringPtr) => {
  const { buffer } = wasm.exports.memory;
  const buf = new Uint8Array(buffer, stringPtr);
  const res = decoder.decode(buf);
  return trimNull(res);
};

export const appendBuffers = (buffer1, buffer2) => {
  const tmp = new Uint8Array(buffer1.byteLength + buffer2.byteLength);
  tmp.set(new Uint8Array(buffer1), 0);
  tmp.set(new Uint8Array(buffer2), buffer1.byteLength);
  return tmp.buffer;
};

export const sizeofStruct = (jsStruct) => {
  const result = jsStruct.reduce((total, [_, primitive, ...rest]) => {
    if (primitive === "char") {
      return (total += sizeOf[primitive] * rest[0]);
    } else {
      return (total += sizeOf[primitive]);
    }
  }, 0);
  return result;
};

export const freeStringPtr = (wasm, ptr) => {
  wasm.exports.freeStringMem(ptr);
};

export const structBuffer2Object = (jsStruct, buffer) => {
  const [result] = jsStruct.reduce(
    ([parameters, offset], [parameterName, primitive, ...rest]) => {
      const currentSize = primitive === "char" ? sizeOf[primitive] * rest[0] : sizeOf[primitive];
      const currentValue =
        primitive === "char"
          ? trimNull(uint2String(buffer.subarray(offset, currentSize))) || ""
          : buffer[offset];
      parameters[parameterName] = currentValue;
      return [parameters, offset + currentSize];
    },
    [{}, 0],
  );
  return result;
};

export const nearestPowerOf2 = (n) => {
  return 1 << (31 - Math.clz32(n));
};

export const isIos = () => /iPhone|iPad|iPod/.test(navigator.userAgent);

const isFirefox = () => navigator.userAgent.toLowerCase().includes("firefox");

export const isSabSupported = () =>
  !isFirefox() &&
  typeof window.Atomics !== "undefined" &&
  typeof window.SharedArrayBuffer !== "undefined";

export const areWorkletsSupported = () =>
  typeof AudioNode !== "undefined" && typeof AudioWorkletNode !== "undefined";

export const WebkitAudioContext = () => {
  if (typeof window.webkitAudioContext !== "undefined") {
    return window.webkitAudioContext;
  } else if (typeof window.AudioContext !== "undefined") {
    return window.AudioContext;
  }
};

export const isScriptProcessorNodeSupported = () => {
  const audioContext = WebkitAudioContext();
  return (
    typeof audioContext !== "undefined" &&
    typeof audioContext.prototype.createScriptProcessor !== "undefined"
  );
};

export const csoundApiRename = (apiName) => {
  const minusCsound = apiName.replace(/^csound/i, "");
  return minusCsound.charAt(0).toLowerCase() + minusCsound.substring(1);
};

export const makeProxyCallback = (proxyPort, csoundInstance, apiK) => async (...arguments_) => {
  return await proxyPort.callUncloned(apiK, [csoundInstance, ...arguments_]);
};

export const makeSingleThreadCallback = (csoundInstance, apiCallback) => async (...arguments_) => {
  return await apiCallback.apply({}, [csoundInstance, ...arguments_]);
  // return await proxyPort.callUncloned(apiK, [csoundInstance, ...arguments_]);
};

export const stopableStates = new Set([
  "realtimePerformanceStarted",
  "realtimePerformancePaused",
  "realtimePerformanceResumed",
  "renderStarted",
]);