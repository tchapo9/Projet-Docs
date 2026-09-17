'use strict';

/**
 * Lumen Docs — gestionnaire de flag « lecture seule » persistant par pad.
 *
 * Au contraire du pointillé `?readOnly=` (qui est marqué dans la session du
 * visiteur au chargement et ne bloque donc pas un nouvel accès sans ce param),
 * ce flag est stocké en base (clé `lumen:readonly:<padId>`) et est consulté
 * SYNCHRONEMENT par `userCanModify()` (webaccess.ts) pour que l'URL seule ne
 * puisse pas le contourner : tant que le pad est marqué, aucune écriture n'est
 * permise même si l'embed est régénéré sans `?readOnly=true`.
 *
 * Les `db.*` étant asynchrones (ueberdb2), on maintient un cache mémoire
 * (module top-level) réhydraté au démarrage, afin de garder la lecture synchrone.
 */

const db = require('../db/DB');

const KEY_PREFIX = 'lumen:readonly:';

// Ensemble des padId marqués lecture seule (lecture synchrone).
const cache = new Set<string>();

/** Préfixe de clé complet pour un padId donné. */
const keyFor = (padId: string) => `${KEY_PREFIX}${padId}`;

/**
 * Charge tous les flags persistants depuis la base dans le cache mémoire.
 * À appeler une seule fois au démarrage (avant le premier userCanModify).
 */
const initCache = async () => {
  const keys: string[] = (await db.findKeys(`${KEY_PREFIX}*`, null)) || [];
  cache.clear();
  await Promise.all(keys.map(async (k: string) => {
    const v = await db.get(k);
    if (v) cache.add(k.slice(KEY_PREFIX.length));
  }));
};

/**
 * Retourne true si le pad est marqué lecture seule (lecture synchrone).
 */
const isReadOnly = (padId: string) => cache.has(padId);

/**
 * Marque (ou démarque) le pad en lecture seule de façon persistante. Met à
 * jour le cache immédiatement (lectures synchrones cohérentes) puis la base.
 */
const setReadOnly = async (padId: string, readOnly: boolean) => {
  const key = keyFor(padId);
  if (readOnly) {
    cache.add(padId);
    await db.set(key, true);
  } else {
    cache.delete(padId);
    await db.remove(key);
  }
};

exports.initCache = initCache;
exports.isReadOnly = isReadOnly;
exports.setReadOnly = setReadOnly;
exports.__keyPrefix = KEY_PREFIX;