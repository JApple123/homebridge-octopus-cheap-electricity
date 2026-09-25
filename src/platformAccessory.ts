import type { PlatformAccessory, Service } from 'homebridge';

import type { OctopusEnergyPlatform } from './platform.js';
import { contactSensorState } from './state.js';

export class OctopusEnergyAccessory {
  private readonly service: Service;

  constructor(
    private readonly platform: OctopusEnergyPlatform,
    private readonly accessory: PlatformAccessory,
  ) {
    const { Service, Characteristic } = platform;

    accessory.getService(Service.AccessoryInformation)!
      .setCharacteristic(Characteristic.Manufacturer, 'Octopus Energy')
      .setCharacteristic(Characteristic.Model, 'Cheap Energy Contact Sensor')
      .setCharacteristic(Characteristic.SerialNumber, 'octopus-cheap-energy');

    const oldSwitch = accessory.getService(Service.Switch);
    if (oldSwitch) {
      accessory.removeService(oldSwitch);
    }

    this.service = accessory.getService(Service.ContactSensor)
      || accessory.addService(Service.ContactSensor, platform.config.name);

    this.service.addOptionalCharacteristic(Characteristic.StatusFault);
    this.service.setCharacteristic(Characteristic.Name, platform.config.name);
    this.markUnavailable();
  }

  updateState(isCheap: boolean, price: number): void {
    this.service
      .getCharacteristic(this.platform.Characteristic.ContactSensorState)
      .updateValue(contactSensorState(
        isCheap,
        this.platform.Characteristic.ContactSensorState,
      ));

    this.platform.log.debug(
      `Electricity price is ${price.toFixed(2)}p/kWh; ` +
      `threshold is ${this.platform.config.threshold.toFixed(2)}p/kWh; ` +
      `state is ${isCheap ? 'OPEN / CONTACT_DETECTED (cheap)' : 'CLOSED / CONTACT_NOT_DETECTED (above threshold)'}.`,
    );
  }

  markUnavailable(): void {
    this.service.updateCharacteristic(
      this.platform.Characteristic.StatusFault,
      1,
    );
  }

  markAvailable(): void {
    this.service.updateCharacteristic(
      this.platform.Characteristic.StatusFault,
      0,
    );
  }

}
