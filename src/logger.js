const { jsonReplacer } = require("./persistence.js");

class StructuredLogger {
  constructor({ sink = console.log } = {}) {
    this.sink = sink;
  }

  log(event, fields = {}) {
    this.sink(
      JSON.stringify(
        {
          timestamp: new Date().toISOString(),
          event,
          ...fields
        },
        jsonReplacer
      )
    );
  }
}

class SilentLogger {
  log() { }
}
module.exports = {
  StructuredLogger,
  SilentLogger
}