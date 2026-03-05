'use strict';
// Stub — real nesting engine not deployed. Sticker sheet nesting unavailable.
class NestingEngine {
  constructor() { throw new Error('NestingEngine not available on this server'); }
}
function createNestingEngine() { throw new Error('NestingEngine not available on this server'); }
module.exports = { NestingEngine, createNestingEngine };
