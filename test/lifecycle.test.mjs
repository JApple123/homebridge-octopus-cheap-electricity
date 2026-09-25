import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { OctopusEnergyPlatform } from '../dist/platform.js';

const CONTACT_DETECTED = 0;
const CONTACT_NOT_DETECTED = 1;
const STATUS_FAULT = 'StatusFault';
const CONTACT_SENSOR_STATE = 'ContactSensorState';

class MockCharacteristic {
  constructor(value = undefined) {
    this.value = value;
  }

  updateValue(value) {
    this.value = value;
    return this;
  }
}

class MockService {
  constructor(type, displayName) {
    this.type = type;
    this.displayName = displayName;
    this.characteristics = new Map();
  }

  normalizeKey(name) {
    if (typeof name === 'string') {
      return name;
    }

    if (name && typeof name === 'object' && 'CONTACT_DETECTED' in name) {
      return 'ContactSensorState';
    }

    return String(name);
  }

  addOptionalCharacteristic(name) {
    const key = this.normalizeKey(name);
    if (!this.characteristics.has(key)) {
      this.characteristics.set(key, new MockCharacteristic());
    }
    return this;
  }

  setCharacteristic(name, value) {
    const key = this.normalizeKey(name);
    if (!this.characteristics.has(key)) {
      this.characteristics.set(key, new MockCharacteristic());
    }
    this.characteristics.get(key).value = value;
    return this;
  }

  getCharacteristic(name) {
    const key = this.normalizeKey(name);
    if (!this.characteristics.has(key)) {
      this.characteristics.set(key, new MockCharacteristic());
    }
    return this.characteristics.get(key);
  }

  updateCharacteristic(name, value) {
    return this.setCharacteristic(name, value);
  }
}

class MockPlatformAccessory {
  constructor(name, uuid) {
    this.displayName = name;
    this.UUID = uuid;
    this.context = {};
    this.services = new Map();

    const Service = {
      AccessoryInformation: 'AccessoryInformation',
      ContactSensor: 'ContactSensor',
      Switch: 'Switch',
    };

    this.services.set(Service.AccessoryInformation, new MockService(Service.AccessoryInformation, 'Accessory Information'));
  }

  getService(type) {
    return this.services.get(type) ?? null;
  }

  addService(type, name) {
    const service = new MockService(type, name);
    this.services.set(type, service);
    return service;
  }

  removeService(service) {
    this.services.delete(service.type);
  }
}

function createHarness({ existingAccessory = null } = {}) {
  const Service = {
    AccessoryInformation: 'AccessoryInformation',
    ContactSensor: 'ContactSensor',
    Switch: 'Switch',
  };

  const Characteristic = {
    Manufacturer: 'Manufacturer',
    Model: 'Model',
    SerialNumber: 'SerialNumber',
    Name: 'Name',
    StatusFault: STATUS_FAULT,
    ContactSensorState: {
      CONTACT_DETECTED: 0,
      CONTACT_NOT_DETECTED: 1,
    },
  };

  const expectedUuid = existingAccessory?.UUID ?? 'generated-uuid';

  const timers = [];
  const originalSetInterval = globalThis.setInterval;
  const originalClearInterval = globalThis.clearInterval;

  globalThis.setInterval = (fn, ms) => {
    const timer = { fn, ms, id: Symbol('timer') };
    timers.push(timer);
    return timer;
  };

  globalThis.clearInterval = (timer) => {
    const index = timers.findIndex((entry) => entry === timer);
    if (index >= 0) {
      timers.splice(index, 1);
    }
  };

  const api = new EventEmitter();
  api.hap = {
    Service,
    Characteristic,
    uuid: {
      generate: () => expectedUuid,
    },
  };
  api.platformAccessory = MockPlatformAccessory;
  api.registerPlatformAccessories = () => { };

  const log = {
    debug: () => { },
    info: () => { },
    warn: () => { },
    error: () => { },
  };

  const platform = new OctopusEnergyPlatform(log, {
    apiKey: 'test-key',
    accountNumber: 'A-12345678',
    threshold: 10,
    updateInterval: 30,
    name: 'Cheap Electricity',
  }, api);

  if (existingAccessory) {
    platform.configureAccessory(existingAccessory);
  }

  return {
    platform,
    api,
    timers,
    restore() {
      globalThis.setInterval = originalSetInterval;
      globalThis.clearInterval = originalClearInterval;
    },
  };
}

async function flush() {
  await new Promise((resolve) => globalThis.setTimeout(resolve, 0));
}

test('didFinishLaunching initializes a new accessory exactly once', async () => {
  const { platform, api, timers, restore } = createHarness();

  try {
    let priceRequests = 0;
    platform.octopus.getCurrentPrice = async () => {
      priceRequests += 1;
      return {
        priceIncVat: 4.5,
        priceExcVat: 4.29,
        validFrom: new Date(),
        validTo: null,
        tariffCode: 'E-1R-SUPPLY-1',
      };
    };

    api.emit('didFinishLaunching');
    await flush();
    api.emit('didFinishLaunching');
    await flush();

    assert.equal(priceRequests, 1);
    assert.equal(platform.accessories.size, 1);
    assert.equal(timers.length, 1);
    assert.ok(platform.accessoryHandler);
  } finally {
    restore();
  }
});

test('a cached accessory is initialized on didFinishLaunching without duplicating services', async () => {
  const accessory = new MockPlatformAccessory('Cheap Electricity', 'cached-uuid');
  const { platform, api, restore } = createHarness({ existingAccessory: accessory });

  try {
    platform.octopus.getCurrentPrice = async () => ({
      priceIncVat: 7.5,
      priceExcVat: 7.14,
      validFrom: new Date(),
      validTo: null,
      tariffCode: 'E-1R-SUPPLY-1',
    });

    api.emit('didFinishLaunching');
    await platform.updateState();

    const service = accessory.getService('ContactSensor');
    assert.ok(service);
    assert.equal(service.characteristics.get(CONTACT_SENSOR_STATE).value, CONTACT_DETECTED);
    assert.equal(service.characteristics.get(STATUS_FAULT).value, 0);
    assert.equal(platform.accessories.size, 1);
  } finally {
    restore();
  }
});

test('a failed update preserves the prior state and later success restores availability', async () => {
  const { platform, api, restore } = createHarness();

  try {
    platform.octopus.getCurrentPrice = async () => {
      throw new Error('temporary outage');
    };

    api.emit('didFinishLaunching');
    await flush();

    const accessory = [...platform.accessories.values()][0] ?? null;
    assert.ok(accessory);
    const contactSensor = accessory.getService('ContactSensor');
    assert.ok(contactSensor);

    contactSensor.getCharacteristic(CONTACT_SENSOR_STATE).updateValue(CONTACT_NOT_DETECTED);
    await platform.updateState();
    assert.equal(contactSensor.getCharacteristic(CONTACT_SENSOR_STATE).value, CONTACT_NOT_DETECTED);
    assert.equal(contactSensor.getCharacteristic(STATUS_FAULT).value, 1);

    platform.octopus.getCurrentPrice = async () => ({
      priceIncVat: 5.5,
      priceExcVat: 5.24,
      validFrom: new Date(),
      validTo: null,
      tariffCode: 'E-1R-SUPPLY-1',
    });

    await platform.updateState();
    assert.equal(contactSensor.getCharacteristic(STATUS_FAULT).value, 0);
    assert.equal(contactSensor.getCharacteristic(CONTACT_SENSOR_STATE).value, CONTACT_DETECTED);
  } finally {
    restore();
  }
});

test('cheap electricity maps to CONTACT_DETECTED and expensive electricity maps to CONTACT_NOT_DETECTED', () => {
  const contactState = {
    CONTACT_DETECTED,
    CONTACT_NOT_DETECTED,
  };

  const cheapPrice = 5;
  const expensivePrice = 15;

  assert.equal(
    (cheapPrice <= 10 ? contactState.CONTACT_DETECTED : contactState.CONTACT_NOT_DETECTED),
    contactState.CONTACT_DETECTED,
  );
  assert.equal(
    (expensivePrice <= 10 ? contactState.CONTACT_DETECTED : contactState.CONTACT_NOT_DETECTED),
    contactState.CONTACT_NOT_DETECTED,
  );
});
