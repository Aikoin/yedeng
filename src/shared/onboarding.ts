import { isConfigured, type Settings } from './settings';
/** A placeholder provider is not a usable configuration. Never reopen the guide on every update. */
export function shouldOfferOnboarding(settings: Settings, seen: unknown): boolean { return !isConfigured(settings) && seen !== true; }
