import type {
  API,
  Characteristic,
  DynamicPlatformPlugin,
  Logging,
  PlatformAccessory,
  PlatformConfig,
  Service,
} from 'homebridge';

import { OctopusClient } from './octopusClient.js';
import { OctopusEnergyAccessory } from './platformAccessory.js';
import { PLATFORM_NAME, PLUGIN_NAME } from './settings.js';
import { isCheapPrice } from './state.js';
import { validateConfig } from './validation.js';

const DEFAULT_UPDATE_INTERVAL_SECONDS = 5 * 60;
const MAX_STATE_AGE_MS = 20 * 60 * 1000;

export interface OctopusEnergyConfig extends PlatformConfig {
  name: string;
  apiKey: string;
  accountNumber: string;
  threshold: number;
  updateInterval: number;
  tariffCode?: string;
}

export class OctopusEnergyPlatform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service;
  public readonly Characteristic: typeof Characteristic;
  public readonly accessories: Map<string, PlatformAccessory> = new Map();
  public readonly discoveredCacheUUIDs: string[] = [];

  public readonly config: OctopusEnergyConfig;

  private readonly octopus: OctopusClient;
  private accessoryHandler?: OctopusEnergyAccessory;
  private updateTimer?: NodeJS.Timeout;
  private lastSuccessfulUpdateAt?: number;

  constructor(
    public readonly log: Logging,
    config: PlatformConfig,
    public readonly api: API,
  ) {
    this.Service = api.hap.Service;
    this.Characteristic = api.hap.Characteristic;

    this.config = {
      ...config,
      name: config.name ?? 'Cheap Electricity',
      threshold: Number(config.threshold ?? 10),
      updateInterval: Number(config.updateInterval ?? DEFAULT_UPDATE_INTERVAL_SECONDS),
    } as OctopusEnergyConfig;

    validateConfig(this.config);

    this.octopus = new OctopusClient(
      this.config.apiKey,
      this.config.accountNumber,
      this.config.tariffCode,
      (message) => this.log.debug(message),
    );

    this.api.on('didFinishLaunching', () => {
      this.log.debug('Homebridge finished launching; discovering Octopus Energy accessory.');
      this.discoverAccessory();
    });

    this.api.on('shutdown', () => {
      if (this.updateTimer) {
        clearInterval(this.updateTimer);
      }
    });
  }

  configureAccessory(accessory: PlatformAccessory): void {
    this.log.info('Loading accessory from cache:', accessory.displayName);
    this.accessories.set(accessory.UUID, accessory);
  }

  private discoverAccessory(): void {
    const uuid = this.api.hap.uuid.generate(`${PLUGIN_NAME}:cheap-energy`);
    this.discoveredCacheUUIDs.push(uuid);

    const existingAccessory = this.accessories.get(uuid);

    if (existingAccessory) {
      this.log.info('Restoring existing Octopus Energy accessory from cache.');
      this.accessoryHandler = new OctopusEnergyAccessory(this, existingAccessory);
    } else {
      this.log.info('Adding Octopus Energy cheap electricity accessory.');

      const accessory = new this.api.platformAccessory(this.config.name, uuid);
      accessory.context.type = 'cheap-energy';

      this.accessoryHandler = new OctopusEnergyAccessory(this, accessory);

      this.api.registerPlatformAccessories(
        PLUGIN_NAME,
        PLATFORM_NAME,
        [accessory],
      );
    }

    this.startUpdates();
  }

  private startUpdates(): void {
    if (this.updateTimer) {
      clearInterval(this.updateTimer);
    }

    void this.updateState();

    this.updateTimer = setInterval(() => {
      if (!this.updateInProgress) {
        void this.updateState();
      }
    }, this.config.updateInterval * 1000);
  }

  private updateInProgress = false;

  private async updateState(): Promise<void> {
    if (!this.accessoryHandler || this.updateInProgress) {
      return;
    }

    this.updateInProgress = true;
    try {
      const currentPrice = await this.octopus.getCurrentPrice();
      const isCheap = isCheapPrice(currentPrice.priceIncVat, this.config.threshold);

      this.accessoryHandler.updateState(isCheap, currentPrice.priceIncVat);
      this.accessoryHandler.markAvailable();
      this.lastSuccessfulUpdateAt = Date.now();

      this.log.debug(
        `Current Octopus electricity price: ${currentPrice.priceIncVat.toFixed(2)}p/kWh ` +
        `(tariff ${currentPrice.tariffCode}${currentPrice.ratePeriod
          ? `, ${currentPrice.ratePeriod}`
          : ''}).`,
      );
    } catch (error) {
      this.accessoryHandler.setUnavailableState();
      this.accessoryHandler.markUnavailable();

      const stateAge = this.lastSuccessfulUpdateAt
        ? Date.now() - this.lastSuccessfulUpdateAt
        : undefined;
      if (stateAge === undefined || stateAge > MAX_STATE_AGE_MS) {
        this.log.warn('Octopus Energy state is stale because no recent price was retrieved.');
      }

      this.log.error(
        `Failed to update Octopus Energy state: ${error instanceof Error ? error.message : String(error)
        }`,
      );
    } finally {
      this.updateInProgress = false;
    }
  }
}
