import assert from 'node:assert/strict';
import { keysForMask } from './src/input.js';

const NEUTRAL = 0xFFFF;
const press = (bit) => (NEUTRAL & ~bit) & 0xFFFF;

assert.deepEqual(keysForMask(1, NEUTRAL), [], 'neutral P1 has no keys');
assert.deepEqual(keysForMask(2, NEUTRAL), [], 'neutral P2 has no keys');
assert.deepEqual(keysForMask(1, press(0x4000)), [0x58], 'P1 cross -> X');
assert.deepEqual(keysForMask(2, press(0x4000)), [0x4E], 'P2 cross -> N');
assert.deepEqual(keysForMask(1, press(0x0040)), [0x28], 'P1 down -> Down arrow');
assert.deepEqual(keysForMask(2, press(0x0008)), [0x08], 'P2 start -> Backspace');
assert.deepEqual(keysForMask(1, press(0x0010 | 0x0020)), [0x26, 0x27], 'P1 up+right');
assert.deepEqual(keysForMask(2, press(0x8000 | 0x2000)), [0x4D, 0xBC], 'P2 circle+square');
assert.equal(keysForMask(1, 0x0000).length, 16, 'all P1 buttons pressed');
assert.equal(keysForMask(2, 0x0000).length, 14, 'all P2 buttons pressed (L3/R3 unbound)');
console.log('input map OK');
