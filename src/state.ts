import type { Client } from "./client.js";

let current: Client | null = null;
export const getClient = (): Client | null => current;
export const setClient = (c: Client | null): void => { current = c; };
