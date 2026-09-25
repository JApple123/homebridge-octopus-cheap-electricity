import { readFile } from 'node:fs/promises';

import { OctopusClient } from '../dist/octopusClient.js';

const configPath = globalThis.process.env.OCTOPUS_CONFIG_PATH?.trim();
let configPlatform;

if (configPath) {
  try {
    const config = JSON.parse(await readFile(configPath, 'utf8'));
    configPlatform = config.platforms?.find((platform) => platform.platform === 'OctopusEnergy');
  } catch (error) {
    globalThis.console.error(`Could not read diagnostic config: ${error instanceof Error ? error.message : String(error)}`);
    globalThis.process.exitCode = 2;
  }
}

const apiKey = globalThis.process.env.OCTOPUS_API_KEY?.trim() || configPlatform?.apiKey?.trim();
const accountNumber = globalThis.process.env.OCTOPUS_ACCOUNT_NUMBER?.trim() || configPlatform?.accountNumber?.trim();
const configuredTariffCode = globalThis.process.env.OCTOPUS_TARIFF_CODE?.trim()
  || configPlatform?.tariffCode?.trim()
  || undefined;

if (!apiKey || !accountNumber) {
  globalThis.console.error('Set OCTOPUS_API_KEY and OCTOPUS_ACCOUNT_NUMBER in the environment. Values are never printed.');
  globalThis.process.exitCode = 2;
} else {
  const originalFetch = globalThis.fetch;
  const requests = [];

  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    const body = typeof init.body === 'string' ? init.body : '';
    const operation = body.match(/(?:query|mutation)\s+([A-Za-z0-9_]+)/)?.[1]
      ?? (url.includes('/accounts/') ? 'REST account' : 'REST request');
    const startedAt = Date.now();
    const response = await originalFetch(input, init);
    const request = {
      operation,
      status: response.status,
      durationMs: Date.now() - startedAt,
    };
    requests.push(request);
    globalThis.console.log(`[request] ${request.operation}: HTTP ${request.status} (${request.durationMs} ms)`);
    return response;
  };

  const debugLog = (message) => {
    globalThis.console.log(`[client] ${message}`);
  };

  try {
    const client = new OctopusClient(
      apiKey,
      accountNumber,
      configuredTariffCode,
      debugLog,
    );
    const price = await client.getCurrentPrice();

    globalThis.console.log(JSON.stringify({
      result: 'success',
      priceIncVat: price.priceIncVat,
      priceExcVat: price.priceExcVat,
      tariffCode: price.tariffCode,
      ratePeriod: price.ratePeriod ?? null,
      requestCount: requests.length,
      requests: requests.map(({ operation, status, durationMs }) => ({ operation, status, durationMs })),
    }, null, 2));

    if (globalThis.process.env.OCTOPUS_DIAGNOSTIC_SECOND_REQUEST === '1') {
      const secondPrice = await client.getCurrentPrice();
      globalThis.console.log(JSON.stringify({
        secondResult: 'success',
        priceIncVat: secondPrice.priceIncVat,
        priceExcVat: secondPrice.priceExcVat,
        ratePeriod: secondPrice.ratePeriod ?? null,
        totalRequestCount: requests.length,
      }, null, 2));
    }
  } catch (error) {
    globalThis.console.error(JSON.stringify({
      result: 'error',
      name: error instanceof Error ? error.name : 'UnknownError',
      message: error instanceof Error ? error.message : String(error),
      requestCount: requests.length,
      requests: requests.map(({ operation, status, durationMs }) => ({ operation, status, durationMs })),
    }, null, 2));
    globalThis.process.exitCode = 1;
  } finally {
    globalThis.fetch = originalFetch;
  }
}
