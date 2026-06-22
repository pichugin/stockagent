/**
 * Footnote shown on any CAD-normalized output. Wealthsimple applies its own FX
 * spread on USD trades, so this market rate won't exactly match the real CAD
 * cost the user paid. We deliberately don't model their spread — we just avoid
 * implying false precision.
 */
export const WS_SPREAD_NOTE =
  'Note: figures use the market FX rate. Wealthsimple applies its own FX spread ' +
  'on USD trades, so your actual CAD cost differs slightly.';
