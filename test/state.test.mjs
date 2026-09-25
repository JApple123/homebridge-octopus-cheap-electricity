import assert from 'node:assert/strict';
import test from 'node:test';

import { contactSensorState, isCheapPrice } from '../dist/state.js';
import { validateConfig } from '../dist/validation.js';

const contactStates = {
  CONTACT_DETECTED: 0,
  CONTACT_NOT_DETECTED: 1,
};

test('prices at or below the threshold are cheap', () => {
  assert.equal(isCheapPrice(8.5, 10), true);
  assert.equal(isCheapPrice(10, 10), true);
  assert.equal(isCheapPrice(15.2, 10), false);
});

test('cheap state maps to Contact Sensor state', () => {
  assert.equal(contactSensorState(true, contactStates), contactStates.CONTACT_DETECTED);
  assert.equal(contactSensorState(false, contactStates), contactStates.CONTACT_NOT_DETECTED);
});

test('configuration validation rejects missing credentials and invalid values', () => {
  const validConfig = {
    apiKey: 'fake-key',
    accountNumber: 'A-XXXXXXXX',
    threshold: 10,
    updateInterval: 60,
  };

  assert.doesNotThrow(() => validateConfig(validConfig));
  assert.throws(() => validateConfig({ ...validConfig, apiKey: '' }), /API key is required/);
  assert.throws(() => validateConfig({ ...validConfig, threshold: -1 }), /non-negative/);
  assert.throws(() => validateConfig({ ...validConfig, updateInterval: 10 }), /at least 30/);
  assert.throws(() => validateConfig({ ...validConfig, accountNumber: 'invalid' }), /must start with A-/);
});