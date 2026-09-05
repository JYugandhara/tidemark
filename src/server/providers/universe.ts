/**
 * The instrument universe used by the simulator and the seed script.
 *
 * These are real NSE tickers with *synthetic* reference parameters: a starting
 * price level, a characteristic daily volatility, and a typical traded volume.
 * They are chosen to be plausible for each name's sector and size so the
 * significance engine has a realistic spread of "normal" to work against — a
 * utility that moves 0.8% a day sitting next to a small-cap that moves 4%.
 *
 * Nothing here is market data. Point `MARKET_PROVIDERS=finnhub` at a real feed
 * for that; this exists so the product is demonstrable at 3am on a Sunday and
 * so tests are deterministic.
 */

export interface UniverseEntry {
  symbol: string;
  name: string;
  sector: string;
  /** Reference price level at the simulation anchor date. */
  basePrice: number;
  /** Characteristic daily volatility as a fraction. */
  dailySigma: number;
  /** Typical shares traded per session. */
  avgVolume: number;
  /** Small annualised drift, so the year of history is not a flat line. */
  annualDrift: number;
}

export const UNIVERSE: readonly UniverseEntry[] = [
  { symbol: "RELIANCE", name: "Reliance Industries", sector: "Energy", basePrice: 1420, dailySigma: 0.0145, avgVolume: 9_800_000, annualDrift: 0.10 },
  { symbol: "TCS", name: "Tata Consultancy Services", sector: "IT Services", basePrice: 3980, dailySigma: 0.0118, avgVolume: 2_600_000, annualDrift: 0.06 },
  { symbol: "HDFCBANK", name: "HDFC Bank", sector: "Banking", basePrice: 1680, dailySigma: 0.0126, avgVolume: 12_400_000, annualDrift: 0.09 },
  { symbol: "INFY", name: "Infosys", sector: "IT Services", basePrice: 1590, dailySigma: 0.0138, avgVolume: 7_100_000, annualDrift: 0.05 },
  { symbol: "ICICIBANK", name: "ICICI Bank", sector: "Banking", basePrice: 1275, dailySigma: 0.0133, avgVolume: 11_900_000, annualDrift: 0.11 },
  { symbol: "BHARTIARTL", name: "Bharti Airtel", sector: "Telecom", basePrice: 1720, dailySigma: 0.0151, avgVolume: 6_300_000, annualDrift: 0.14 },
  { symbol: "SBIN", name: "State Bank of India", sector: "Banking", basePrice: 830, dailySigma: 0.0162, avgVolume: 15_700_000, annualDrift: 0.08 },
  { symbol: "LT", name: "Larsen & Toubro", sector: "Infrastructure", basePrice: 3610, dailySigma: 0.0147, avgVolume: 2_100_000, annualDrift: 0.12 },
  { symbol: "ITC", name: "ITC", sector: "FMCG", basePrice: 425, dailySigma: 0.0109, avgVolume: 14_200_000, annualDrift: 0.04 },
  { symbol: "HINDUNILVR", name: "Hindustan Unilever", sector: "FMCG", basePrice: 2480, dailySigma: 0.0104, avgVolume: 1_900_000, annualDrift: 0.02 },
  { symbol: "AXISBANK", name: "Axis Bank", sector: "Banking", basePrice: 1155, dailySigma: 0.0158, avgVolume: 9_400_000, annualDrift: 0.07 },
  { symbol: "KOTAKBANK", name: "Kotak Mahindra Bank", sector: "Banking", basePrice: 1810, dailySigma: 0.0141, avgVolume: 4_800_000, annualDrift: 0.03 },
  { symbol: "MARUTI", name: "Maruti Suzuki", sector: "Automobile", basePrice: 12_450, dailySigma: 0.0156, avgVolume: 640_000, annualDrift: 0.09 },
  { symbol: "TATAMOTORS", name: "Tata Motors", sector: "Automobile", basePrice: 705, dailySigma: 0.0224, avgVolume: 21_500_000, annualDrift: 0.13 },
  { symbol: "SUNPHARMA", name: "Sun Pharmaceutical", sector: "Pharma", basePrice: 1685, dailySigma: 0.0137, avgVolume: 3_200_000, annualDrift: 0.10 },
  { symbol: "TITAN", name: "Titan Company", sector: "Consumer", basePrice: 3390, dailySigma: 0.0163, avgVolume: 1_700_000, annualDrift: 0.06 },
  { symbol: "ASIANPAINT", name: "Asian Paints", sector: "Materials", basePrice: 2410, dailySigma: 0.0148, avgVolume: 2_300_000, annualDrift: -0.03 },
  { symbol: "BAJFINANCE", name: "Bajaj Finance", sector: "NBFC", basePrice: 7150, dailySigma: 0.0193, avgVolume: 1_450_000, annualDrift: 0.05 },
  { symbol: "WIPRO", name: "Wipro", sector: "IT Services", basePrice: 268, dailySigma: 0.0159, avgVolume: 13_800_000, annualDrift: 0.01 },
  { symbol: "HCLTECH", name: "HCL Technologies", sector: "IT Services", basePrice: 1615, dailySigma: 0.0142, avgVolume: 3_600_000, annualDrift: 0.07 },
  { symbol: "ULTRACEMCO", name: "UltraTech Cement", sector: "Materials", basePrice: 11_280, dailySigma: 0.0151, avgVolume: 480_000, annualDrift: 0.08 },
  { symbol: "NTPC", name: "NTPC", sector: "Power", basePrice: 372, dailySigma: 0.0128, avgVolume: 17_900_000, annualDrift: 0.06 },
  { symbol: "POWERGRID", name: "Power Grid Corporation", sector: "Power", basePrice: 296, dailySigma: 0.0117, avgVolume: 15_100_000, annualDrift: 0.04 },
  { symbol: "ONGC", name: "Oil & Natural Gas Corporation", sector: "Energy", basePrice: 248, dailySigma: 0.0176, avgVolume: 19_600_000, annualDrift: 0.02 },
  { symbol: "COALINDIA", name: "Coal India", sector: "Energy", basePrice: 398, dailySigma: 0.0169, avgVolume: 12_700_000, annualDrift: 0.03 },
  { symbol: "TATASTEEL", name: "Tata Steel", sector: "Metals", basePrice: 158, dailySigma: 0.0212, avgVolume: 38_400_000, annualDrift: 0.05 },
  { symbol: "JSWSTEEL", name: "JSW Steel", sector: "Metals", basePrice: 1042, dailySigma: 0.0198, avgVolume: 4_100_000, annualDrift: 0.06 },
  { symbol: "HINDALCO", name: "Hindalco Industries", sector: "Metals", basePrice: 689, dailySigma: 0.0221, avgVolume: 9_300_000, annualDrift: 0.09 },
  { symbol: "ADANIENT", name: "Adani Enterprises", sector: "Conglomerate", basePrice: 2380, dailySigma: 0.0312, avgVolume: 3_900_000, annualDrift: 0.04 },
  { symbol: "ADANIPORTS", name: "Adani Ports & SEZ", sector: "Infrastructure", basePrice: 1345, dailySigma: 0.0248, avgVolume: 5_600_000, annualDrift: 0.11 },
  { symbol: "ZOMATO", name: "Eternal (Zomato)", sector: "Internet", basePrice: 268, dailySigma: 0.0287, avgVolume: 44_200_000, annualDrift: 0.18 },
  { symbol: "PAYTM", name: "One97 Communications", sector: "Fintech", basePrice: 812, dailySigma: 0.0361, avgVolume: 8_700_000, annualDrift: -0.06 },
  { symbol: "NYKAA", name: "FSN E-Commerce Ventures", sector: "Internet", basePrice: 196, dailySigma: 0.0298, avgVolume: 11_400_000, annualDrift: -0.02 },
  { symbol: "DMART", name: "Avenue Supermarts", sector: "Retail", basePrice: 4180, dailySigma: 0.0172, avgVolume: 780_000, annualDrift: 0.01 },
  { symbol: "IRCTC", name: "Indian Railway Catering & Tourism", sector: "Travel", basePrice: 762, dailySigma: 0.0234, avgVolume: 5_200_000, annualDrift: 0.03 },
  { symbol: "IDEA", name: "Vodafone Idea", sector: "Telecom", basePrice: 8.4, dailySigma: 0.0412, avgVolume: 312_000_000, annualDrift: -0.15 },
  { symbol: "YESBANK", name: "Yes Bank", sector: "Banking", basePrice: 19.6, dailySigma: 0.0327, avgVolume: 96_000_000, annualDrift: -0.04 },
  { symbol: "SUZLON", name: "Suzlon Energy", sector: "Renewables", basePrice: 58.3, dailySigma: 0.0386, avgVolume: 74_000_000, annualDrift: 0.22 },
  { symbol: "BEL", name: "Bharat Electronics", sector: "Defence", basePrice: 412, dailySigma: 0.0219, avgVolume: 18_300_000, annualDrift: 0.17 },
  { symbol: "HAL", name: "Hindustan Aeronautics", sector: "Defence", basePrice: 4650, dailySigma: 0.0227, avgVolume: 1_600_000, annualDrift: 0.15 },
];

export const UNIVERSE_BY_SYMBOL: ReadonlyMap<string, UniverseEntry> = new Map(
  UNIVERSE.map((u) => [u.symbol, u]),
);
