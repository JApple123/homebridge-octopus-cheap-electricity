import assert from 'node:assert/strict';
import test from 'node:test';

import { OctopusApiError, OctopusClient } from '../dist/octopusClient.js';

const tariffCode = 'E-1R-IOG-TEST-A';
const accountResponse = {
  properties: [{
    postcode: 'AB1 2CD',
    electricity_meter_points: [{
      agreements: [{
        tariff_code: tariffCode,
        valid_from: '2020-01-01T00:00:00Z',
        valid_to: null,
      }],
    }],
  }],
};

const productResponse = {
  data: {
    energyProduct: {
      tariffs: {
        edges: [{
          node: {
            __typename: 'FourRateEvTariff',
            tariffCode,
            dayRate: 24,
            nightRate: 8,
            preVatDayRate: 22.857,
            preVatNightRate: 7.619,
          },
        }],
      },
    },
  },
};

function jsonResponse(body, status = 200) {
  return new globalThis.Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function installClock() {
  const originalDate = globalThis.Date;
  const fixedTime = new originalDate('2026-09-25T12:00:00Z');

  class FixedDate extends originalDate {
    constructor(...args) {
      super(...(args.length === 0 ? [fixedTime] : args));
    }

    static now() {
      return fixedTime.getTime();
    }
  }

  globalThis.Date = FixedDate;
  return () => {
    globalThis.Date = originalDate;
  };
}

function installFetch(handler) {
  const originalFetch = globalThis.fetch;
  const requests = [];

  globalThis.fetch = async (input, init = {}) => {
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
    requests.push({ input: String(input), body });
    return handler(String(input), body, requests.length);
  };

  return {
    requests,
    restore() {
      globalThis.fetch = originalFetch;
    },
  };
}

function graphqlResponse(body) {
  const query = body?.query ?? '';
  if (query.includes('obtainKrakenToken')) {
    return jsonResponse({
      data: {
        obtainKrakenToken: {
          token: 'test-token',
          refreshToken: 'test-refresh-token',
          refreshExpiresIn: 4102444800,
        },
      },
    });
  }
  if (query.includes('energyProduct')) {
    return jsonResponse(productResponse);
  }
  if (query.includes('devices')) {
    return jsonResponse({
      data: {
        devices: [{ __typename: 'SmartFlexVehicle', id: 'device-1' }],
      },
    });
  }
  if (query.includes('flexPlannedDispatches')) {
    return jsonResponse({
      data: {
        flexPlannedDispatches: [{
          start: '2026-09-25T11:00:00Z',
          end: '2026-09-25T13:00:00Z',
          type: 'SMART',
        }],
      },
    });
  }
  throw new Error('Unexpected GraphQL query');
}

function createClient(debugLog = () => { }) {
  return new OctopusClient('test-key', 'A-TEST1234', undefined, debugLog);
}

test('Intelligent Go active SMART dispatch selects the night rate', async () => {
  const restoreClock = installClock();
  const fetchHarness = installFetch((input, body) => {
    if (input.includes('/accounts/')) {
      return jsonResponse(accountResponse);
    }
    return graphqlResponse(body);
  });

  try {
    const price = await createClient().getCurrentPrice();

    assert.equal(price.priceIncVat, 8);
    assert.equal(price.priceExcVat, 7.619);
    assert.equal(price.ratePeriod, 'smart charging');
    assert.equal(fetchHarness.requests.length, 5);
  } finally {
    fetchHarness.restore();
    restoreClock();
  }
});

test('missing Intelligent Go schedule data falls back to the day rate and is cached', async () => {
  const restoreClock = installClock();
  const fetchHarness = installFetch((input, body) => {
    if (input.includes('/accounts/')) {
      return jsonResponse(accountResponse);
    }
    const query = body?.query ?? '';
    if (query.includes('devices')) {
      return jsonResponse({ data: { devices: [] } });
    }
    return graphqlResponse(body);
  });

  try {
    const client = createClient();
    const firstPrice = await client.getCurrentPrice();
    const secondPrice = await client.getCurrentPrice();

    assert.equal(firstPrice.priceIncVat, 24);
    assert.equal(firstPrice.ratePeriod, 'day');
    assert.equal(secondPrice.priceIncVat, 24);
    assert.equal(fetchHarness.requests.length, 4);
  } finally {
    fetchHarness.restore();
    restoreClock();
  }
});

test('Intelligent Go schedule GraphQL errors fall back and enter a retry cooldown', async () => {
  const restoreClock = installClock();
  const debugMessages = [];
  const fetchHarness = installFetch((input, body) => {
    if (input.includes('/accounts/')) {
      return jsonResponse(accountResponse);
    }
    const query = body?.query ?? '';
    if (query.includes('flexPlannedDispatches')) {
      return jsonResponse({ errors: [{ message: 'temporary schedule failure' }] });
    }
    return graphqlResponse(body);
  });

  try {
    const client = createClient((message) => debugMessages.push(message));
    const firstPrice = await client.getCurrentPrice();
    const secondPrice = await client.getCurrentPrice();

    assert.equal(firstPrice.priceIncVat, 24);
    assert.equal(firstPrice.ratePeriod, 'day');
    assert.equal(secondPrice.priceIncVat, 24);
    assert.equal(fetchHarness.requests.length, 5);
    assert.ok(debugMessages.some((message) => message.includes('schedule unavailable')));
  } finally {
    fetchHarness.restore();
    restoreClock();
  }
});

test('REST account failure remains a hard price update failure', async () => {
  const fetchHarness = installFetch(() => jsonResponse({ error: 'unavailable' }, 503));

  try {
    await assert.rejects(
      createClient().getCurrentPrice(),
      (error) => error instanceof OctopusApiError && error.status === 503,
    );
  } finally {
    fetchHarness.restore();
  }
});

test('malformed REST JSON remains a hard price update failure', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new globalThis.Response('{', {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

  try {
    await assert.rejects(
      createClient().getCurrentPrice(),
      (error) => error instanceof OctopusApiError && error.message.includes('invalid JSON'),
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('standard tariffs use the REST unit-rate response', async () => {
  const standardTariff = 'E-1R-VAR-TEST-A';
  const requests = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    requests.push(String(input));
    if (String(input).includes('/standard-unit-rates/')) {
      return jsonResponse({
        results: [{
          value_inc_vat: 9,
          value_exc_vat: 8.571,
          valid_from: '2020-01-01T00:00:00Z',
          valid_to: null,
        }],
      });
    }
    throw new Error(`Unexpected request: ${String(input)}`);
  };

  try {
    const price = await new OctopusClient('test-key', 'A-TEST1234', standardTariff).getCurrentPrice();
    assert.equal(price.priceIncVat, 9);
    assert.equal(price.priceExcVat, 8.571);
    assert.equal(requests.length, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
