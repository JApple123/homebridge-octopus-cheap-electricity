# Homebridge Octopus Energy

A Homebridge plugin for Octopus Energy customers in the UK.

The plugin exposes a single HomeKit Contact Sensor whose state represents whether the household electricity rate is at or below a configured threshold.

## Current behaviour

For example, with:

- Threshold: `10` p/kWh
- Update interval: `300` seconds (5 minutes)

the accessory will be:

- Contact Detected when the current household electricity rate including VAT is `<= 10p/kWh`
- Closed / Contact Not Detected when it is `> 10p/kWh`

The Contact Sensor is a read-only representation of an external state. Contact Detected means electricity is cheap. The plugin does not control your tariff or supply.

The plugin currently uses Octopus Energy's REST API. It discovers the current import electricity tariff from the account endpoint unless a tariff code is supplied manually. It polls every five minutes by default and keeps Intelligent Go charging schedules cached for ten minutes.

## Requirements

- Node.js 22 or later
- Homebridge 1.8+ / 2.x
- An Octopus Energy API key
- An Octopus Energy account number

The plugin requires Node.js 22+ and Homebridge 1.8+.

## Installation

Install the published plugin globally:

```bash
npm install -g homebridge-octopus-cheap-electricity
```

## Configuration

Add the platform in Homebridge Config UI or use a configuration like this with fake credentials:

```json
{
  "platforms": [
    {
      "name": "Cheap Electricity",
      "platform": "OctopusEnergy",
      "apiKey": "YOUR_API_KEY",
      "accountNumber": "A-XXXXXXXX",
      "threshold": 10,
      "updateInterval": 300
    }
  ]
}
```

`threshold` is the VAT-inclusive electricity price in p/kWh. Contact Detected means the current price is at or below the threshold. Closed / Contact Not Detected means there is no cheap electricity because the price is above the threshold.

## Development

Clone the repository and install dependencies:

```bash
git clone https://github.com/JApple123/homebridge-octopus-cheap-electricity.git
cd homebridge-octopus-cheap-electricity
npm install
```

Build:

```bash
npm run build
```

Lint:

```bash
npm run lint
```

## Install into Homebridge while developing

After building:

```bash
npm link
```

Then add the platform through the Homebridge UI, or add it to your Homebridge configuration.

Example:

```json
{
  "platforms": [
    {
      "name": "Cheap Electricity",
      "platform": "OctopusEnergy",
      "apiKey": "YOUR_OCTOPUS_API_KEY",
      "accountNumber": "A-XXXXXXXX",
      "threshold": 10,
      "updateInterval": 300
    }
  ]
}
```

Restart Homebridge with debug logging while developing:

```bash
homebridge -D
```

## Development mode

The repository includes a development Homebridge configuration under:

```text
test/hbConfig/config.json
```

Copy `test/hbConfig/config.example.json` to `test/hbConfig/config.json` and fill in credentials locally. The latter file is ignored by Git and must never be committed.

Then run:

```bash
npm run watch
```

This builds the TypeScript, links the plugin and starts Homebridge using the development configuration.

Do **not** commit your real API key or account number.

## Troubleshooting

- Authentication failure: check that the API key is valid and has not been copied with extra whitespace.
- Invalid account number: use the account number beginning with `A-`.
- Tariff cannot be detected: check that the account has a current import electricity agreement; a useful error is logged when the tariff format is unsupported.
- No current price: wait for the next poll and check the Octopus API status.
- Plugin not appearing: confirm the platform name is exactly `OctopusEnergy`, then restart Homebridge.
- API temporarily unavailable: the sensor is marked unavailable and polling continues automatically.
- Stale state warning: after an extended outage, the retained sensor state is marked unavailable until a fresh price is retrieved.

## Octopus API

The plugin uses:

```text
https://api.octopus.energy/v1/
```

The account endpoint is used to discover the active import electricity tariff. The price endpoint is then queried for the current time period.

Octopus authenticates REST requests using the API key as the username with an empty password. For newer four-rate Intelligent Octopus Go tariffs, it reads the household day and night rates from Octopus's GraphQL product tariff data.

## Tariff discovery

By default the plugin:

1. Calls the account endpoint.
2. Finds current electricity meter points.
3. Ignores export meter points.
4. Finds the current agreement.
5. Extracts its tariff code.
6. Derives the product code.
7. Requests the current unit rate.
8. Compares the VAT-inclusive rate with the configured threshold.

If automatic tariff-code discovery does not work for a particular tariff, set `tariffCode` manually in the Homebridge configuration.

## Intelligent Octopus Go

The Contact Sensor answers:

> "Is the current household unit rate below my configured threshold?"


## Project structure

```text
src/
├── index.ts
├── settings.ts
├── platform.ts
├── platformAccessory.ts
└── octopusClient.ts

test/
└── hbConfig/
    └── config.json

config.schema.json
package.json
tsconfig.json
eslint.config.js
nodemon.json
```

### Responsibilities

`index.ts`
- Registers the Homebridge platform.

`settings.ts`
- Defines the Homebridge platform/plugin names.

`platform.ts`
- Owns the Homebridge lifecycle.
- Creates the accessory.
- Polls Octopus.
- Converts price to the cheap/not-cheap state.

`octopusClient.ts`
- Owns all Octopus API communication.
- Discovers the active tariff.
- Retrieves the current unit price.

`platformAccessory.ts`
- Owns the HomeKit Contact Sensor service.

## Current functionality

- [x] Homebridge dynamic platform
- [x] Octopus account authentication
- [x] Automatic current tariff discovery
- [x] Current electricity price
- [x] Configurable cheap-price threshold
- [x] HomeKit Contact Sensor
- [x] Polling
- [x] Basic API error handling

## Versioning

The package follows semantic versioning. Publishing is intentionally a manual step.
