import type { OctopusEnergyConfig } from './platform.js';

export function validateConfig(config: OctopusEnergyConfig): void {
  if (!config.apiKey?.trim()) {
    throw new Error('Octopus Energy API key is required.');
  }

  if (!config.accountNumber?.trim()) {
    throw new Error('Octopus Energy account number is required.');
  }

  if (!/^A-[A-Z0-9]+$/i.test(config.accountNumber.trim())) {
    throw new Error('Octopus Energy account number must start with A- and contain only letters and numbers.');
  }

  if (!Number.isFinite(config.threshold) || config.threshold < 0) {
    throw new Error('Octopus Energy threshold must be a non-negative number in p/kWh.');
  }

  if (!Number.isFinite(config.updateInterval) || config.updateInterval < 30) {
    throw new Error('Octopus Energy update interval must be at least 30 seconds.');
  }
}