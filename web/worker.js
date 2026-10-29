import { Dataset } from "./data.js";

let dataset;
let generation = 0;
let active = 0;
const queue = [];

async function execute(message) {
  const { id, method, args, token } = message;
  try {
    if (method === "tile" && token !== generation) throw new Error("Forecast view changed.");
    let result;
    if (method === "open") {
      dataset = new Dataset(args[0]);
      result = await dataset.open();
    } else {
      if (!dataset) throw new Error("Connect to a Zarr store first.");
      result = await dataset[method](...args);
    }
    self.postMessage({ id, result }, result instanceof Uint8ClampedArray ? [result.buffer] : []);
  } catch (error) {
    self.postMessage({ id, error: error.message });
  }
}

function drain() {
  while (active < 4 && queue.length) {
    const message = queue.shift();
    active++;
    execute(message).finally(() => { active--; drain(); });
  }
}

self.onmessage = event => {
  if (event.data.method === "generation") {
    generation = event.data.token;
    return;
  }
  queue.push(event.data);
  drain();
};
