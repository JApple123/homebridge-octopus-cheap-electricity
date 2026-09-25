import type { Characteristic } from 'homebridge';

export function isCheapPrice(priceIncVat: number, threshold: number): boolean {
  return priceIncVat <= threshold;
}

export function contactSensorState(
  isCheap: boolean,
  contactSensorState: typeof Characteristic.ContactSensorState,
): number {
  return isCheap
    ? contactSensorState.CONTACT_NOT_DETECTED
    : contactSensorState.CONTACT_DETECTED;
}