const API_BASE_URL = 'https://api.octopus.energy/v1';
const GRAPHQL_URL = `${API_BASE_URL}/graphql/`;
const INTELLIGENT_GO_SCHEDULE_CACHE_MS = 60 * 1000;
const INTELLIGENT_GO_SCHEDULE_RETRY_MS = 60 * 1000;

interface OctopusAgreement {
  tariff_code: string;
  valid_from: string;
  valid_to: string | null;
}

interface OctopusMeterPoint {
  agreements?: OctopusAgreement[];
  is_export?: boolean;
}

interface OctopusProperty {
  postcode?: string;
  electricity_meter_points?: OctopusMeterPoint[];
}

interface OctopusAccount {
  properties?: OctopusProperty[];
}

interface OctopusPrice {
  value_inc_vat: number;
  value_exc_vat: number;
  valid_from: string;
  valid_to: string | null;
}

interface OctopusPriceResponse {
  results: OctopusPrice[];
}

interface OctopusGraphqlResponse<T> {
  data?: T;
  errors?: Array<{ message?: string }>;
}

interface OctopusKrakenTokenResponse {
  obtainKrakenToken?: {
    token?: string;
    refreshToken?: string;
    refreshExpiresIn?: number;
  } | null;
}

interface OctopusIntelligentGoTariff {
  __typename?: string;
  tariffCode?: string;
  dayRate?: number | null;
  nightRate?: number | null;
  preVatDayRate?: number | null;
  preVatNightRate?: number | null;
}

interface OctopusEnergyProductResponse {
  energyProduct?: {
    tariffs?: {
      edges?: Array<{ node?: OctopusIntelligentGoTariff }>;
    };
  } | null;
}

interface OctopusSmartFlexDevice {
  __typename?: string;
  id: string;
}

interface OctopusDevicesResponse {
  devices?: OctopusSmartFlexDevice[] | null;
}

interface OctopusSmartFlexDispatch {
  start: string;
  end: string;
  type: string;
}

interface OctopusSmartFlexDispatchesResponse {
  flexPlannedDispatches?: OctopusSmartFlexDispatch[] | null;
}

interface IntelligentGoScheduleCache {
  dispatches: OctopusSmartFlexDispatch[];
  expiresAt: number;
}

interface IntelligentGoRateCache {
  productCode: string;
  postcode: string;
  tariffCode: string;
  dayRate: number;
  nightRate: number;
  preVatDayRate?: number;
  preVatNightRate?: number;
  expiresAt: number;
}

type IntelligentGoRatePeriod = 'day' | 'overnight off-peak' | 'smart charging';

export interface CurrentEnergyPrice {
  priceIncVat: number;
  priceExcVat: number;
  validFrom: Date;
  validTo: Date | null;
  tariffCode: string;
  ratePeriod?: IntelligentGoRatePeriod;
}

export class OctopusApiError extends Error {
  constructor(message: string, public readonly status?: number) {
    super(message);
    this.name = 'OctopusApiError';
  }
}

export class OctopusClient {
  private tariffCode?: string;
  private account?: OctopusAccount;
  private graphqlAccessToken?: string;
  private graphqlAccessTokenExpiresAt = 0;
  private graphqlRefreshToken?: string;
  private graphqlRefreshTokenExpiresAt = 0;
  private graphqlAuthenticationBlockedUntil = 0;
  private scheduleCache?: IntelligentGoScheduleCache;
  private scheduleRefreshPromise?: Promise<OctopusSmartFlexDispatch[]>;
  private scheduleRetryAt = 0;
  private intelligentGoRateCache?: IntelligentGoRateCache;

  constructor(
    private readonly apiKey: string,
    private readonly accountNumber: string,
    private readonly configuredTariffCode?: string,
    private readonly debugLog?: (message: string) => void,
  ) { }

  /**
   * Gets the current electricity unit price in p/kWh, including VAT.
   *
   * If tariffCode is configured, it is used directly. Otherwise the client
   * discovers the current import electricity tariff from the account endpoint.
   */
  async getCurrentPrice(): Promise<CurrentEnergyPrice> {
    const tariffCode = await this.getTariffCode();
    const productCode = this.getProductCode(tariffCode);
    this.debugLog?.(`Using import tariff ${tariffCode} and product ${productCode}.`);

    // The REST standard-unit-rates endpoint exposes the standard (day) rate
    // for Octopus's newer four-rate Intelligent Go tariffs. Their household
    // night rate is published on the GraphQL product tariff instead.
    if (/^IOG-/i.test(productCode)) {
      return this.getIntelligentGoPrice(productCode, tariffCode, new Date());
    }

    const now = new Date();
    const periodFrom = new Date(now.getTime() - 60 * 60 * 1000);
    const periodTo = new Date(now.getTime() + 60 * 60 * 1000);

    let response: OctopusPriceResponse | undefined;

    for (const rateEndpoint of ['standard-unit-rates', 'day-unit-rates']) {
      const url = new URL(
        `${API_BASE_URL}/products/${encodeURIComponent(productCode)}/electricity-tariffs/${encodeURIComponent(tariffCode)}/${rateEndpoint}/`,
      );

      url.searchParams.set('period_from', periodFrom.toISOString());
      url.searchParams.set('period_to', periodTo.toISOString());

      const candidate = await this.request<Partial<OctopusPriceResponse>>(url);

      if (Array.isArray(candidate.results) && candidate.results.length > 0) {
        response = { results: candidate.results };
        break;
      }
    }

    const current = this.findCurrentPrice(response?.results ?? [], now);

    if (!current) {
      throw new OctopusApiError(
        `No electricity price was returned for the current time from tariff ${tariffCode}. ` +
        'The tariff rate endpoints returned no applicable rates.',
      );
    }

    return {
      priceIncVat: current.value_inc_vat,
      priceExcVat: current.value_exc_vat,
      validFrom: new Date(current.valid_from),
      validTo: current.valid_to ? new Date(current.valid_to) : null,
      tariffCode,
    };
  }

  private async getIntelligentGoPrice(
    productCode: string,
    tariffCode: string,
    now: Date,
  ): Promise<CurrentEnergyPrice> {
    const postcode = await this.getPostcode(tariffCode);
    let rates = this.intelligentGoRateCache;
    if (!rates
      || rates.productCode !== productCode
      || rates.postcode !== postcode
      || rates.tariffCode !== tariffCode
      || now.getTime() >= rates.expiresAt) {
      const query = `query EnergyProduct($code: String!, $postcode: String!) {
        energyProduct(code: $code) {
          tariffs(postcode: $postcode, first: 100) {
            edges {
              node {
                __typename
                ... on FourRateEvTariff {
                  tariffCode
                  dayRate
                  nightRate
                  preVatDayRate
                  preVatNightRate
                }
              }
            }
          }
        }
      }`;

      const response = await this.requestGraphql<OctopusEnergyProductResponse>(query, {
        code: productCode,
        postcode,
      });

      if (response.errors?.length) {
        throw new OctopusApiError(
          `Octopus GraphQL API could not read Intelligent Go rates: ${response.errors
            .map((error) => error.message ?? 'Unknown GraphQL error')
            .join('; ')}`,
        );
      }

      const tariff = response.data?.energyProduct?.tariffs?.edges
        ?.map((edge) => edge.node)
        .find((node) => node?.tariffCode === tariffCode);

      if (tariff?.__typename !== 'FourRateEvTariff'
        || tariff.dayRate == null
        || tariff.nightRate == null) {
        throw new OctopusApiError(
          `Octopus did not return four-rate day and night prices for Intelligent Go tariff ${tariffCode}.`,
        );
      }

      rates = {
        productCode,
        postcode,
        tariffCode,
        dayRate: tariff.dayRate,
        nightRate: tariff.nightRate,
        preVatDayRate: tariff.preVatDayRate ?? undefined,
        preVatNightRate: tariff.preVatNightRate ?? undefined,
        expiresAt: now.getTime() + INTELLIGENT_GO_SCHEDULE_CACHE_MS,
      };
      this.intelligentGoRateCache = rates;
      this.debugLog?.('Refreshed the Intelligent Go product-rate cache.');
    } else {
      this.debugLog?.('Reusing cached Intelligent Go product rates.');
    }

    const isNightRate = this.isIntelligentGoHomeOffPeak(now);
    this.debugLog?.(
      `Using Intelligent Go ${isNightRate ? 'overnight off-peak' : 'day'} rate; ` +
      `${isNightRate ? 'smart dispatch lookup is not required.' : 'checking for an active SMART dispatch.'}`,
    );
    let smartDispatches: OctopusSmartFlexDispatch[] = [];
    if (!isNightRate) {
      try {
        smartDispatches = await this.getSmartDispatches(now);
      } catch (error) {
        this.scheduleRetryAt = Date.now() + INTELLIGENT_GO_SCHEDULE_RETRY_MS;
        this.debugLog?.(
          `Intelligent Go schedule unavailable; using the day rate until the next retry: ${error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
    const isSmartCharging = smartDispatches.some((dispatch) => {
      const start = new Date(dispatch.start).getTime();
      const end = new Date(dispatch.end).getTime();
      return dispatch.type.toUpperCase() === 'SMART'
        && Number.isFinite(start)
        && Number.isFinite(end)
        && start <= now.getTime()
        && now.getTime() < end;
    });
    const useNightRate = isSmartCharging || isNightRate;
    const priceIncVat = useNightRate ? rates.nightRate : rates.dayRate;
    const priceExcVat = useNightRate
      ? rates.preVatNightRate
      : rates.preVatDayRate;

    return {
      priceIncVat,
      // GraphQL publishes VAT-inclusive and pre-VAT values. Keep the existing
      // field meaningful if an API response omits the latter.
      priceExcVat: priceExcVat ?? priceIncVat / 1.05,
      validFrom: now,
      validTo: null,
      tariffCode,
      ratePeriod: isSmartCharging
        ? 'smart charging'
        : isNightRate ? 'overnight off-peak' : 'day',
    };
  }

  private async getSmartDispatches(now: Date): Promise<OctopusSmartFlexDispatch[]> {
    if (this.scheduleCache && now.getTime() < this.scheduleCache.expiresAt) {
      this.debugLog?.('Reusing cached Intelligent Go smart-charging schedule.');
      return this.scheduleCache.dispatches;
    }

    if (now.getTime() < this.scheduleRetryAt) {
      this.debugLog?.('Skipping Intelligent Go schedule refresh during the retry cooldown.');
      return [];
    }

    if (this.scheduleRefreshPromise) {
      this.debugLog?.('Waiting for the existing Intelligent Go schedule refresh.');
      return this.scheduleRefreshPromise;
    }

    this.scheduleRefreshPromise = this.fetchSmartDispatches(now)
      .then((dispatches) => {
        this.scheduleCache = {
          dispatches,
          expiresAt: Date.now() + INTELLIGENT_GO_SCHEDULE_CACHE_MS,
        };
        this.debugLog?.('Refreshed the Intelligent Go smart-charging schedule cache.');
        return dispatches;
      })
      .finally(() => {
        this.scheduleRefreshPromise = undefined;
      });

    return this.scheduleRefreshPromise;
  }

  private async fetchSmartDispatches(now: Date): Promise<OctopusSmartFlexDispatch[]> {
    const deviceQuery = `query Devices($accountNumber: String!) {
      devices(accountNumber: $accountNumber) {
        __typename
        id
      }
    }`;
    const devicesResponse = await this.requestGraphql<OctopusDevicesResponse>(deviceQuery, {
      accountNumber: this.accountNumber,
    });
    this.throwGraphqlErrors(devicesResponse, 'find Intelligent Go devices');

    const deviceIds = (devicesResponse.data?.devices ?? [])
      .filter((device) => device.__typename === 'SmartFlexVehicle'
        || device.__typename === 'SmartFlexChargePoint')
      .map((device) => device.id);

    if (deviceIds.length === 0) {
      return [];
    }

    const dispatchQuery = `query FlexPlannedDispatches($deviceId: String!) {
      flexPlannedDispatches(deviceId: $deviceId) {
        start
        end
        type
      }
    }`;

    const dispatchResults = await Promise.all(deviceIds.map(async (deviceId) => {
      const response = await this.requestGraphql<OctopusSmartFlexDispatchesResponse>(dispatchQuery, {
        deviceId,
      });
      this.throwGraphqlErrors(response, 'read Intelligent Go charging schedules');
      return response.data?.flexPlannedDispatches ?? [];
    }));

    // Only Octopus's SMART dispatches make the whole-house rate cheaper.
    // BOOST periods are customer-initiated and remain at the standard rate.
    const scheduleHorizon = now.getTime() + 24 * 60 * 60 * 1000;
    return dispatchResults.flat().filter((dispatch) => {
      const start = new Date(dispatch.start).getTime();
      const end = new Date(dispatch.end).getTime();
      return dispatch.type.toUpperCase() === 'SMART'
        && Number.isFinite(start)
        && Number.isFinite(end)
        && end > now.getTime()
        && start < scheduleHorizon;
    });
  }

  private throwGraphqlErrors<T>(
    response: OctopusGraphqlResponse<T>,
    action: string,
  ): void {
    if (response.errors?.length) {
      throw new OctopusApiError(`Octopus GraphQL API could not ${action}.`);
    }
  }

  private isIntelligentGoHomeOffPeak(now: Date): boolean {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Europe/London',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(now);
    const hour = Number(parts.find((part) => part.type === 'hour')?.value);
    const minute = Number(parts.find((part) => part.type === 'minute')?.value);
    const minuteOfDay = hour * 60 + minute;

    // Intelligent Octopus Go's household off-peak window is 23:30–05:30 UK time.
    return minuteOfDay >= 23 * 60 + 30 || minuteOfDay < 5 * 60 + 30;
  }

  private async getTariffCode(): Promise<string> {
    if (this.configuredTariffCode) {
      return this.configuredTariffCode;
    }

    if (this.tariffCode) {
      return this.tariffCode;
    }

    const account = await this.getAccount();

    const agreements = (account.properties ?? []).flatMap((property) =>
      (property.electricity_meter_points ?? [])
        .filter((meterPoint) => meterPoint.is_export !== true)
        .flatMap((meterPoint) => (meterPoint.agreements ?? []).map((agreement) => ({
          agreement,
          postcode: property.postcode,
        }))),
    );

    const now = Date.now();

    const currentAgreement = agreements
      .filter(({ agreement }) => {
        const from = new Date(agreement.valid_from).getTime();
        const to = agreement.valid_to ? new Date(agreement.valid_to).getTime() : Infinity;
        return from <= now && now < to;
      })
      .sort((a, b) => new Date(b.agreement.valid_from).getTime()
        - new Date(a.agreement.valid_from).getTime())[0];

    if (!currentAgreement) {
      throw new OctopusApiError(
        'Could not find a current import electricity tariff in the Octopus account.',
      );
    }

    this.tariffCode = currentAgreement.agreement.tariff_code;
    return this.tariffCode;
  }

  private async getPostcode(tariffCode: string): Promise<string> {
    const account = await this.getAccount();
    const properties = account.properties ?? [];
    const now = Date.now();
    const matchingProperty = properties.find((property) =>
      (property.electricity_meter_points ?? [])
        .filter((meterPoint) => meterPoint.is_export !== true)
        .some((meterPoint) => (meterPoint.agreements ?? []).some((agreement) => {
          const from = new Date(agreement.valid_from).getTime();
          const to = agreement.valid_to ? new Date(agreement.valid_to).getTime() : Infinity;
          return agreement.tariff_code === tariffCode && from <= now && now < to;
        })),
    );
    const postcode = matchingProperty?.postcode ?? properties.find((property) => property.postcode)?.postcode;

    if (!postcode?.trim()) {
      throw new OctopusApiError(
        `Could not find a property postcode for tariff ${tariffCode} in the Octopus account response.`,
      );
    }

    return postcode.trim();
  }

  private async getAccount(): Promise<OctopusAccount> {
    if (!this.account) {
      const url = `${API_BASE_URL}/accounts/${encodeURIComponent(this.accountNumber)}/`;
      this.account = await this.request<OctopusAccount>(url);
    }

    return this.account;
  }

  /**
   * Octopus tariff codes normally look like:
   * E-1R-GO-VAR-22-10-14-A
   * E-2R-VAR-22-11-01-A
   *
   * The product code is the tariff code without the meter-register prefix
   * and regional suffix.
   */
  private getProductCode(tariffCode: string): string {
    const match = tariffCode.match(/^E-[12]R-(.+)-([A-P])$/);

    if (!match) {
      throw new OctopusApiError(
        `Cannot derive a product code from tariff code "${tariffCode}". ` +
        'Set the tariffCode explicitly in the plugin configuration and check the Octopus API format.',
      );
    }

    return match[1];
  }

  private async request<T>(input: string | URL, init: RequestInit = {}): Promise<T> {
    const credentials = Buffer.from(`${this.apiKey}:`).toString('base64');

    let response: Response;
    const headers = new Headers(init.headers);
    headers.set('Authorization', `Basic ${credentials}`);
    headers.set('Accept', 'application/json');

    try {
      response = await fetch(input, {
        ...init,
        headers,
      });
    } catch (error) {
      throw new OctopusApiError(
        `Could not connect to the Octopus Energy API: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    if (!response.ok) {
      const reason = response.status === 401 || response.status === 403
        ? 'authentication failed; check the API key'
        : `HTTP ${response.status}`;
      throw new OctopusApiError(`Octopus Energy API request failed: ${reason}`, response.status);
    }

    try {
      return await response.json() as T;
    } catch (error) {
      throw new OctopusApiError(
        `Octopus Energy API returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /** GraphQL uses Kraken JWT credentials; REST continues to use the API key via Basic auth. */
  private async requestGraphql<T>(
    query: string,
    variables: Record<string, string>,
  ): Promise<OctopusGraphqlResponse<T>> {
    const token = await this.getGraphqlAccessToken();
    const response = await this.fetchJson<OctopusGraphqlResponse<T>>(GRAPHQL_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ query, variables }),
    });
    return response;
  }

  private async getGraphqlAccessToken(): Promise<string> {
    if (Date.now() < this.graphqlAuthenticationBlockedUntil) {
      throw new OctopusApiError(
        'Octopus GraphQL authentication is temporarily backed off after a failed attempt.',
        401,
      );
    }

    // Refresh a little before the documented one-hour access-token expiry.
    if (this.graphqlAccessToken && Date.now() < this.graphqlAccessTokenExpiresAt) {
      return this.graphqlAccessToken;
    }

    const useRefreshToken = this.graphqlRefreshToken
      && Date.now() < this.graphqlRefreshTokenExpiresAt;
    const query = `mutation ObtainKrakenToken($input: ObtainJSONWebTokenInput!) {
      obtainKrakenToken(input: $input) {
        token
        refreshToken
        refreshExpiresIn
      }
    }`;
    const input = useRefreshToken
      ? { refreshToken: this.graphqlRefreshToken }
      : { APIKey: this.apiKey };
    let response: OctopusGraphqlResponse<OctopusKrakenTokenResponse>;
    try {
      response = await this.fetchJson<OctopusGraphqlResponse<OctopusKrakenTokenResponse>>(
        GRAPHQL_URL,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ query, variables: { input } }),
        },
      );
      this.throwGraphqlErrors(response, 'obtain GraphQL credentials');
    } catch (error) {
      if (error instanceof OctopusApiError
        && (error.status === 401 || error.status === 403 || error.message.includes('credentials'))) {
        this.graphqlAuthenticationBlockedUntil = Date.now() + 5 * 60 * 1000;
        throw new OctopusApiError(
          'Octopus GraphQL authentication failed; retrying after a short backoff.',
          error.status,
        );
      }
      throw error;
    }

    const result = response.data?.obtainKrakenToken;
    if (!result?.token) {
      throw new OctopusApiError('Octopus GraphQL API did not return an access token.');
    }

    this.graphqlAccessToken = result.token;
    this.graphqlAccessTokenExpiresAt = Date.now() + 55 * 60 * 1000;
    if (result.refreshToken) {
      this.graphqlRefreshToken = result.refreshToken;
    }
    if (result.refreshExpiresIn) {
      // Octopus returns refreshExpiresIn as a Unix timestamp in seconds.
      this.graphqlRefreshTokenExpiresAt = result.refreshExpiresIn * 1000;
    }

    return result.token;
  }

  private async fetchJson<T>(input: string | URL, init: RequestInit): Promise<T> {
    let response: Response;
    const headers = new Headers(init.headers);
    headers.set('Accept', 'application/json');
    try {
      response = await fetch(input, { ...init, headers });
    } catch (error) {
      throw new OctopusApiError(
        `Could not connect to the Octopus Energy API: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (!response.ok) {
      const reason = response.status === 401 || response.status === 403
        ? 'authentication failed; check the API key'
        : `HTTP ${response.status}`;
      throw new OctopusApiError(
        `Octopus Energy API request failed: ${reason}`,
        response.status,
      );
    }
    try {
      return await response.json() as T;
    } catch (error) {
      throw new OctopusApiError(
        `Octopus Energy API returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private findCurrentPrice(prices: OctopusPrice[], now: Date): OctopusPrice | undefined {
    const timestamp = now.getTime();

    return prices
      .filter((price) => {
        const from = new Date(price.valid_from).getTime();
        const to = price.valid_to ? new Date(price.valid_to).getTime() : Infinity;

        return from <= timestamp && timestamp < to;
      })
      .sort((a, b) => new Date(b.valid_from).getTime() - new Date(a.valid_from).getTime())[0];
  }
}
