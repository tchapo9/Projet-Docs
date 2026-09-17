'use strict';

import path from 'node:path';
import express from 'express';
const eejs = require('../../eejs')
import fs from 'node:fs';
const fsp = fs.promises;
const toolbar = require('../../utils/toolbar');
const hooks = require('../../../static/js/pluginfw/hooks');
import settings, {getEpVersion} from '../../utils/Settings';
import {ensureAuthorTokenCookie} from '../../utils/ensureAuthorTokenCookie';
import util from 'node:util';
const webaccess = require('./webaccess');
const padutils = require('../../../static/js/pad_utils').default;
const plugins = require('../../../static/js/pluginfw/plugin_defs');
const i18n = require('../i18n');
import {renderSocialMeta} from '../../utils/socialMeta';

import {build, buildSync} from 'esbuild'
import {ArgsExpressType} from "../../types/ArgsExpressType";
import prometheus from "../../prometheus";
const lumenReadOnly = require('../../utils/lumenReadOnly');
const APIKeyHandler = require('../../handler/APIKeyHandler');
const PadMessageHandler = require('../../handler/PadMessageHandler');
const crypto = require('crypto');

// Instance socket.io capturée au boot (voir exports.socketio). Typée au
// minimum pour les usages de la lecture (itération des sockets + emit).
let ioI: { sockets: { sockets: any; socket?: any; }; } | null = null

// ── Lumen Docs — role cache (authorId → {role, userName}) ────
const LUMEN_PLUGIN_SECRET = process.env.LUMEN_PLUGIN_SECRET || 'lumen-etherpad-shared-secret-change-me';
const lumenRoleCache = new Map<string, {role: string; userName: string | null}>();
const lumenSocketToAuthor = new Map<string, {padId: string; authorId: string}>();
// Map padId:lumenUserId → authorId for reliable kick lookups
const lumenUserToAuthor = new Map<string, string>();

function lumenVerifyToken(token: string): any {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const [hdr, payload, sig] = parts;
    const expected = crypto.createHmac('sha256', LUMEN_PLUGIN_SECRET).update(`${hdr}.${payload}`).digest('base64url');
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString());
    if (data.exp && Date.now() > data.exp * 1000) return null;
    return data;
  } catch { return null; }
}

function lumenSetRole(padId: string, authorId: string, role: string, userName?: string, lumenUserId?: number | string) {
  console.log(`[lumen/setRole] padId=${padId} authorId=${authorId} role=${role} userName=${userName} lumenUserId=${lumenUserId}`);
  lumenRoleCache.set(`${padId}:${authorId}`, {role, userName: userName || null});
  if (lumenUserId != null) {
    lumenUserToAuthor.set(`${padId}:${lumenUserId}`, authorId);
  }
}
function lumenDelAllForPad(padId: string) {
  for (const k of lumenRoleCache.keys()) {
    if (k.startsWith(`${padId}:`)) lumenRoleCache.delete(k);
  }
  for (const k of lumenUserToAuthor.keys()) {
    if (k.startsWith(`${padId}:`)) lumenUserToAuthor.delete(k);
  }
}
function lumenGetRole(padId: string, authorId: string) {
  return lumenRoleCache.get(`${padId}:${authorId}`) || null;
}
function lumenGetAuthorForUser(padId: string, lumenUserId: number | string) {
  return lumenUserToAuthor.get(`${padId}:${lumenUserId}`) || null;
}

function lumenSendReadOnly(socket: any, readonly: boolean, role: string) {
  socket.emit('message', {
    type: 'COLLABROOM',
    data: {
      type: 'CLIENT_MESSAGE',
      payload: {type: 'LUMEN_SET_READONLY', readonly, role},
    },
  });
}

function lumenKickUser(padId: string, authorId: string, role: string) {
  try {
    const infos = (PadMessageHandler.sessioninfos || {}) as Record<string, any>;
    const isRO = role === 'viewer' || role === 'commenter';
    console.log(`[lumen/kickUser] padId=${padId} authorId=${authorId} role=${role} isRO=${isRO}`);
    const allSessions = Object.entries(infos)
      .filter(([, s]) => s && s.padId === padId)
      .map(([sid, s]) => ({socketId: sid, author: s.author, readonly: s.readonly}));
    console.log(`[lumen/kickUser] all sessions for pad:`, JSON.stringify(allSessions));
    for (const [sid, s] of Object.entries(infos)) {
      if (!s || s.padId !== padId || s.author !== authorId) continue;
      console.log(`[lumen/kickUser] MATCH found: socketId=${sid} author=${s.author} was Readonly=${s.readonly} setting to=${isRO}`);
      s.readonly = isRO;
      const sock = ioI?.sockets?.sockets?.get?.(sid);
      if (sock) {
        lumenSendReadOnly(sock, isRO, role);
        console.log(`[lumen/kickUser] sent LUMEN_SET_READONLY to socket ${sid}`);
      } else {
        console.log(`[lumen/kickUser] socket ${sid} not found in io`);
      }
    }
  } catch (e) { console.error('[lumen/kickUser] error:', e); }
}

// Shared sanitizer for the `x-proxy-path` header. See the helper for the
// allowed character class and the protocol-relative / traversal rejection
// rules. Reused by admin.ts so both call sites share one definition.
import {sanitizeProxyPath} from '../../utils/sanitizeProxyPath';

// Public routes echo the proxy-path headers into rendered URLs, social-preview
// metadata, manifest links and the legacy timeslider redirect. Advertise the
// headers in Vary so a shared cache/CDN in front of Etherpad keys on them and
// can't serve a proxy-path injected by one client to another (cache poisoning).
// Mirrors the admin-route fix in admin.ts (GHSA-fjgc-3mj7-8rg8).
//
// Only vary on the headers sanitizeProxyPath() actually consults for the
// current config: x-proxy-path is always honored, but x-forwarded-prefix and
// x-ingress-path are ignored unless trustProxy is enabled — varying on them
// then would only fragment shared caches without affecting the response.
const varyOnProxyPath = (res: any) => {
  res.vary('x-proxy-path');
  if (settings.trustProxy) res.vary(['x-forwarded-prefix', 'x-ingress-path']);
};


exports.socketio = (hookName: string, {io}: any) => {
  ioI = io
}


exports.expressPreSession = async (hookName:string, {app}:ArgsExpressType) => {
  // Lumen Docs — hydrate le cache du flag lecture seule persistant avant que
  // les premières requêtes /p/* ne consultent userCanModify (lecture synchrone).
  try {
    await lumenReadOnly.initCache();
  } catch (e:any) {
    console.error(`[lumenReadOnly] initCache failed: ${e?.stack || e}`);
  }

  // This endpoint is intended to conform to:
  // https://www.ietf.org/archive/id/draft-inadarei-api-health-check-06.html
  app.get('/health', (req:any, res:any) => {
    res.set('Content-Type', 'application/health+json');
    res.json({
      status: 'pass',
      releaseId: getEpVersion(),
    });
  });

  // Lumen Docs — endpoint de révocation du droit de saisie.
  //  * Authentification: en-tête `Authorization: <apikey>` (APIKEY.txt).
  //  * Body JSON: {padId, userId?, revoke}
  //  * Grain "pad entier": omet userId → tous les sockets du pad sont rétrogradés.
  //  * Grain "utilisateur précis": userId = authorID (clientVars.userId).
  //  * revoke=true : persiste le flag RO + kick temps réel.
  //  * revoke=false : lève le flag (n'a pas d'effet sur les sessions déjà ouvertes).
  app.post('/lumen-setRO', express.json(), (req:any, res:any) => {
    (async () => {
      const expected = APIKeyHandler.apikey;
      const provided = req.headers.authorization || '';
      const ok = expected != null && expected.trim().length > 0 &&
          Buffer.byteLength(provided) === Buffer.byteLength(expected) &&
          crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
      if (!ok) return res.status(401).json({ok: false, error: 'unauthorized'});

      const {padId, userId, revoke, persist} = req.body || {};
      if (typeof padId !== 'string' || padId.length === 0) {
        return res.status(400).json({ok: false, error: 'missing padId'});
      }

      // Persistance (cache + base). Affecte aussi les futurs accès.
      // persist=false → kick temps réel sans flag durable (révocation ponctuelle
      // d'un utilisateur, les accès légitimes redeviennent éditables au reload).
      if (persist !== false) {
        await lumenReadOnly.setReadOnly(padId, !!revoke);
      }

      // Kick temps réel (seulement si on rétrograde et seulement si une action
      // de kick est demandée — applyToSessions est traitée ci-dessous).
      const kick = (s: any, socketId: string) => {
        s.readonly = true;
        const ns = ioI?.sockets;
        const sock = ns && ns.sockets &&
            (typeof ns.sockets.get === 'function' ? ns.sockets.get(socketId) :
                (typeof ns.socket === 'function' ? ns.socket(socketId) : undefined));
        console.log(`[lumen-kick] socketId=${socketId} ioI=${!!ioI} ns=${!!ns} nsSockets=${!!ns?.sockets} sock=${!!sock}`);
        if (!sock) {
          console.log(`[lumen-kick] socket not found for id=${socketId}, listing available:`, [...((ns?.sockets?.keys?.() || []) as any)].slice(0, 5));
        }
        sock?.emit('message', {
          type: 'COLLABROOM',
          data: {
            type: 'CLIENT_MESSAGE',
            payload: {type: 'LUMEN_SET_READONLY', readonly: true},
          },
        });
      };

      let kicked = 0;
      if (revoke) {
        const infos = (PadMessageHandler.sessioninfos || {}) as Record<string, any>;
        const allSessions = Object.entries(infos)
          .filter(([, s]) => s && s.padId === padId)
          .map(([sid, s]) => ({socketId: sid, author: s.author, readonly: s.readonly}));
        console.log(`[lumen-setRO] padId=${padId} userId=${userId} revoke=${revoke} persist=${persist}`);
        console.log(`[lumen-setRO] sessions on pad:`, JSON.stringify(allSessions));
        for (const [socketId, s] of Object.entries(infos)) {
          if (!s) continue;
          if (s.padId !== padId) continue;
          if (userId != null && s.author !== userId) continue;
          kick(s, socketId);
          kicked++;
        }
        console.log(`[lumen-setRO] kicked=${kicked}`);
      }

      res.json({ok: true, kicked});
    })().catch((e:any) => {
      console.error(`[lumen-setRO] ${e?.stack || e}`);
      res.status(500).json({ok: false, error: 'internal_error'});
    });
  });

  // ── Lumen Docs — /lumen-plugin/* routes ──────────────────
  const parseJson = (req: any, res: any, next: Function) => {
    let body = '';
    req.on('data', (c: string) => { body += c; });
    req.on('end', () => {
      try { req.body = body ? JSON.parse(body) : {}; } catch { req.body = {}; }
      next();
    });
  };
  const requirePluginAuth = (req: any, res: any, next: Function) => {
    if (req.headers.authorization !== LUMEN_PLUGIN_SECRET) {
      return res.status(403).json({error: 'forbidden'});
    }
    next();
  };

  // POST /lumen-plugin/kick — set role + kick user in real time
  app.post('/lumen-plugin/kick', express.json(), requirePluginAuth, (req: any, res: any) => {
    const {padId, authorId, role, userName} = req.body || {};
    if (!padId || !authorId || !role) {
      return res.status(400).json({error: 'missing padId, authorId, or role'});
    }
    lumenSetRole(padId, authorId, role, userName);
    lumenKickUser(padId, authorId, role);
    res.json({ok: true, padId, authorId, role});
  });

  // POST /lumen-plugin/kick-user — kick by Lumen userId (reliable, no name matching)
  app.post('/lumen-plugin/kick-user', express.json(), requirePluginAuth, (req: any, res: any) => {
    const {padId, userId, role, userName} = req.body || {};
    if (!padId || !userId || !role) {
      return res.status(400).json({error: 'missing padId, userId, or role'});
    }
    let authorId = lumenGetAuthorForUser(padId, userId);

    // NO name-based fallback here — it risks kicking the wrong user (e.g. the owner).
    // If the mapping is empty, the user simply hasn't connected yet; the role will be
    // applied when they join via userJoin.

    if (!authorId) {
      return res.json({ok: false, padId, userId, role, reason: 'authorId not found — user may not be connected yet'});
    }
    lumenSetRole(padId, authorId, role, userName, userId);
    lumenKickUser(padId, authorId, role);
    res.json({ok: true, padId, userId, authorId, role});
  });

  // POST /lumen-plugin/kick-all — reset all roles for a pad
  app.post('/lumen-plugin/kick-all', express.json(), requirePluginAuth, (req: any, res: any) => {
    const {padId, roles} = req.body || {};
    if (!padId || !Array.isArray(roles)) {
      return res.status(400).json({error: 'missing padId or roles'});
    }
    lumenDelAllForPad(padId);
    for (const {authorId, role, userName} of roles) {
      if (authorId && role) {
        lumenSetRole(padId, authorId, role, userName);
        lumenKickUser(padId, authorId, role);
      }
    }
    res.json({ok: true, padId, updated: roles.length});
  });

  // POST /lumen-plugin/resolve — validate a token
  app.post('/lumen-plugin/resolve', express.json(), requirePluginAuth, (req: any, res: any) => {
    const {token} = req.body || {};
    if (!token) return res.status(400).json({error: 'missing token'});
    const data = lumenVerifyToken(token);
    if (!data) return res.status(401).json({error: 'invalid token'});
    const {padId, authorId, role, userName} = data;
    if (padId && authorId && role) lumenSetRole(padId, authorId, role, userName);
    res.json({valid: true, padId, authorId, role, userName});
  });

  if (settings.enableMetrics) {
    app.get('/stats', (req:any, res:any) => {
      res.json(require('../../stats').toJSON());
    });

    app.get('/stats/prometheus', async (req, res) => {
      const metrics = await prometheus()
      res.setHeader('Content-Type', metrics.contentType)
      res.send(await metrics.metrics())
    })
  }


  app.get('/javascript', (req:any, res:any) => {
    res.send(eejs.require('ep_etherpad-lite/templates/javascript.html', {req}));
  });

  app.get('/robots.txt', (req:any, res:any) => {
    if (!settings.skinName) {
      // if no skin is set, send the default robots.txt
      return res.sendFile(path.join(settings.root, 'src', 'static', 'robots.txt'));
    }
    let filePath =
      path.join(settings.root, 'src', 'static', 'skins', settings.skinName, 'robots.txt');
    res.sendFile(filePath, (err:any) => {
      // there is no custom robots.txt, send the default robots.txt which dissallows all
      if (err) {
        filePath = path.join(settings.root, 'src', 'static', 'robots.txt');
        res.sendFile(filePath);
      }
    });
  });

  app.get('/favicon.ico', (req:any, res:any, next:Function) => {
    (async () => {
      /*
        If this is a url we simply redirect to that one.
       */
      if (settings.favicon && settings.favicon.startsWith('http')) {
        res.redirect(settings.favicon);
        res.send();
        return;
      }


      const fns = [
        ...(settings.favicon ? [path.resolve(settings.root, settings.favicon)] : []),
        settings.skinName && path.join(settings.root, 'src', 'static', 'skins', settings.skinName, 'favicon.ico'),
        path.join(settings.root, 'src', 'static', 'favicon.ico'),
      ].filter(f=>f != null);
      for (const fn of fns) {
        try {
          await fsp.access(fn, fs.constants.R_OK);
        } catch (err) {
          continue;
        }
        res.setHeader('Cache-Control', `public, max-age=${settings.maxAge}`);
        await util.promisify(res.sendFile.bind(res))(fn);
        return;
      }
      next();
    })().catch((err) => next(err || new Error(err)));
  });
};



const convertTypescript = (content: string) => {
  const outputRaw = buildSync({
    stdin: {
      contents: content,
      resolveDir: path.join(settings.root, 'var','js'),
      loader: 'js'
    },
    alias:{
      "ep_etherpad-lite/static/js/browser": 'ep_etherpad-lite/static/js/vendors/browser',
      "ep_etherpad-lite/static/js/nice-select": 'ep_etherpad-lite/static/js/vendors/nice-select'
    },
    bundle: true, // Bundle the files together
    minify: process.env.NODE_ENV === "production", // Minify the output
    sourcemap: !(process.env.NODE_ENV === "production"), // Generate source maps
    sourceRoot: settings.root+"/src/static/js/",
    target: ['es2020'], // Target ECMAScript version
    metafile: true,
    write: false, // Do not write to file system,
  })
  const output = outputRaw.outputFiles[0].text

  return  {
    output,
    hash: outputRaw.outputFiles[0].hash.replaceAll('/','2').replaceAll("+",'5').replaceAll("^","7")
  }
}

const handleLiveReload = async (args: ArgsExpressType, padString: string, timeSliderString: string, indexString: any) => {
  const chokidar = await import('chokidar')
  const watcher = chokidar.watch(path.join(settings.root, 'src', 'static', 'js'), {});
  let routeHandlers: { [key: string]: Function } = {};

  const setRouteHandler = (path: string, newHandler: Function) => {
    routeHandlers[path] = newHandler;
  };
  args.app.use((req: any, res: any, next: Function) => {
    if (req.path.startsWith('/p/') && req.path.split('/').length == 3) {
      req.params = {
        pad: req.path.split('/')[2]
      }
      routeHandlers['/p/:pad'](req, res);
    } else if (req.path.startsWith('/p/') && req.path.split('/').length == 4) {
      req.params = {
        pad: req.path.split('/')[2]
      }
      routeHandlers['/p/:pad/timeslider'](req, res);
    } else if (req.path == "/"){
      routeHandlers['/'](req, res);
    } else if (routeHandlers[req.path]) {
      routeHandlers[req.path](req, res);
    } else {
      next();
    }
  });

  function handleUpdate() {

    convertTypescriptWatched(indexString, (output, hash) => {
      setRouteHandler('/watch/index', (req: any, res: any) => {
        res.header('Content-Type', 'application/javascript');
        res.send(output)
      })
      setRouteHandler('/', (req: any, res: any) => {
        const proxyPath = sanitizeProxyPath(req);
        varyOnProxyPath(res);
        const socialMetaHtml = renderSocialMeta({
          req, settings, availableLangs: i18n.availableLangs, locales: i18n.locales, kind: 'home',
          proxyPath,
        });
        res.send(eejs.require('ep_etherpad-lite/templates/index.html', {req, entrypoint: proxyPath + '/watch/index?hash=' + hash, settings, socialMetaHtml, proxyPath}));
      })
    })

    convertTypescriptWatched(padString, (output, hash) => {
      console.log("New pad hash is", hash)
      setRouteHandler('/watch/pad', (req: any, res: any) => {
        res.header('Content-Type', 'application/javascript');
        res.send(output)
      })




      setRouteHandler("/p/:pad", (req: any, res: any, next: Function) => {
        ensureAuthorTokenCookie(req, res, settings);
        // The below might break for pads being rewritten
        const isReadOnly = !webaccess.userCanModify(req.params.pad, req);

        hooks.callAll('padInitToolbar', {
          toolbar,
          isReadOnly
        });

        const proxyPath = sanitizeProxyPath(req);
        varyOnProxyPath(res);
        const socialMetaHtml = renderSocialMeta({
          req, settings, availableLangs: i18n.availableLangs, locales: i18n.locales, kind: 'pad', padName: req.params.pad,
          proxyPath,
        });
        const content = eejs.require('ep_etherpad-lite/templates/pad.html', {
          req,
          toolbar,
          isReadOnly,
          entrypoint: proxyPath + '/watch/pad?hash=' + hash,
          settings: settings.getPublicSettings(),
          socialMetaHtml,
          proxyPath,
        })
        res.send(content);
      })
      ioI!.sockets.sockets.forEach((socket:any) => socket.emit('liveupdate'))
    })
    convertTypescriptWatched(timeSliderString, (output, hash) => {
      // serve timeslider.html under /p/$padname/timeslider
      console.log("New timeslider hash is", hash)

      setRouteHandler('/watch/timeslider', (req: any, res: any) => {
        res.header('Content-Type', 'application/javascript');
        res.send(output)
      })

      setRouteHandler("/p/:pad/timeslider", (req: any, res: any, next: Function) => {
        // Direct visits (legacy bookmarks) get redirected back to the pad,
        // where the in-pad PadModeController handles entering history mode.
        // The iframe used by history mode requests this URL with ?embed=1
        // and gets the full timeslider HTML rendered for embedded use.
        if (req.query.embed !== '1') {
          return res.redirect(302, `../${encodeURIComponent(req.params.pad)}`);
        }
        ensureAuthorTokenCookie(req, res, settings);
        // The below might break for pads being rewritten
        const isReadOnly = !webaccess.userCanModify(req.params.pad, req);

        hooks.callAll('padInitToolbar', {
          toolbar,
          isReadOnly
        });

        const proxyPath = sanitizeProxyPath(req);
        varyOnProxyPath(res);
        const socialMetaHtml = renderSocialMeta({
          req, settings, availableLangs: i18n.availableLangs, locales: i18n.locales, kind: 'timeslider', padName: req.params.pad,
          proxyPath,
        });
        const content = eejs.require('ep_etherpad-lite/templates/timeslider.html', {
          req,
          toolbar,
          isReadOnly,
          embed: true,
          entrypoint: proxyPath + '/watch/timeslider?hash=' + hash,
          settings: settings.getPublicSettings(),
          socialMetaHtml,
          proxyPath,
        })
        res.send(content);
      })
    })
  }

  watcher.on('change', path => {
    console.log(`File ${path} has been changed`);
    handleUpdate();
  });
  handleUpdate()
}

const convertTypescriptWatched = (content: string, cb: (output:string, hash: string)=>void) => {
  build({
    stdin: {
      contents: content,
      resolveDir: path.join(settings.root, 'var','js'),
      loader: 'js'
    },
    alias:{
      "ep_etherpad-lite/static/js/browser": 'ep_etherpad-lite/static/js/vendors/browser',
      "ep_etherpad-lite/static/js/nice-select": 'ep_etherpad-lite/static/js/vendors/nice-select'
    },
    bundle: true, // Bundle the files together
    minify: process.env.NODE_ENV === "production", // Minify the output
    sourcemap: !(process.env.NODE_ENV === "production"), // Generate source maps
    sourceRoot: settings.root+"/src/static/js/",
    target: ['es2020'], // Target ECMAScript version
    metafile: true,
    write: false, // Do not write to file system,
  }).then((outputRaw) => {
    cb(
      outputRaw.outputFiles[0].text,
      outputRaw.outputFiles[0].hash.replaceAll('/','2').replaceAll("+",'5').replaceAll("^","7")
    )
  })
}

// ── Lumen Docs — userJoin hook ──────────────────────────────
// Called after CLIENT_READY — force readonly for viewers/commenters
// ── Lumen Docs — handleMessageSecurity hook ──────────────────
// Called for every incoming message BEFORE the readOnly gate at PadMessageHandler:596.
// If the user's cached role is editor, return 'permitOnce' to override the pinned
// messageReadonly flag — this is what makes Viewer→Editor transitions take effect
// on already-open sessions.
exports.handleMessageSecurity = async (hookName: string, context: any) => {
  const {sessionInfo} = context;
  console.log(`[lumen/handleMessageSecurity] called: padId=${sessionInfo?.padId} authorId=${sessionInfo?.authorId} readOnly=${sessionInfo?.readOnly}`);
  if (!sessionInfo || !sessionInfo.authorId || !sessionInfo.padId) {
    console.log('[lumen/handleMessageSecurity] missing padId/authorId, skipping');
    return;
  }
  const entry = lumenGetRole(sessionInfo.padId, sessionInfo.authorId);
  console.log(`[lumen/handleMessageSecurity] cache entry:`, entry);
  if (!entry) {
    console.log(`[lumen/handleMessageSecurity] no role cached for pad=${sessionInfo.padId} author=${sessionInfo.authorId}`);
    return;
  }
  const isEditor = entry.role === 'editor';
  console.log(`[lumen/handleMessageSecurity] role=${entry.role} isEditor=${isEditor} readOnly=${sessionInfo.readOnly}`);
  // If session is still marked readonly but role says editor → permit the write.
  if (sessionInfo.readOnly && isEditor) {
    console.log('[lumen/handleMessageSecurity] returning permitOnce!');
    return 'permitOnce';
  }
};

exports.userJoin = async (hookName: string, context: any) => {
  const {authorId, displayName, padId, readOnly, socket} = context;
  if (!padId || !authorId || !socket) return;

  // Direct lookup by authorId (Etherpad)
  let cached = lumenGetRole(padId, authorId);

  // If not found, the cache is keyed by Lumen userId (from the token).
  // Search all entries for this pad and match by userName/displayName to
  // resolve the correct authorId ↔ userId mapping.
  if (!cached) {
    const name = (displayName || '').trim();
    if (name) {
      for (const [key, value] of lumenRoleCache.entries()) {
        if (!key.startsWith(`${padId}:`)) continue;
        if (value.userName && value.userName.trim() === name) {
          // key = "padId:lumenUserId" → extract userId
          const parts = key.split(':');
          const lumenUserId = parts[parts.length - 1];
          // Store both directions
          lumenUserToAuthor.set(`${padId}:${lumenUserId}`, authorId);
          lumenRoleCache.set(`${padId}:${authorId}`, value);
          cached = value;
          console.log(`[lumen/userJoin] resolved authorId=${authorId} ↔ userId=${lumenUserId} for pad=${padId}`);
          break;
        }
      }
    }
    if (!cached) return;
  }

  // Also store the bidirectional mapping if userId is known from the token
  const roleEntry = lumenRoleCache.get(`${padId}:${authorId}`);
  if (roleEntry) {
    // Check if there's a pending userId mapping to complete
    for (const [key, val] of lumenRoleCache.entries()) {
      if (key.startsWith(`${padId}:`) && key !== `${padId}:${authorId}` && val === roleEntry) {
        const lumenUserId = key.split(':')[1];
        lumenUserToAuthor.set(`${padId}:${lumenUserId}`, authorId);
        break;
      }
    }
  }

  const {role, userName} = cached;
  const isRO = role === 'viewer' || role === 'commenter';

  // Force Lumen display name
  if (userName) {
    try {
      const authorManager = require('../../handler/AuthorManager');
      await authorManager.setAuthorName(authorId, userName);
    } catch {}
  }

  // Track socket for cleanup
  lumenSocketToAuthor.set(socket.id, {padId, authorId});

  // Force readonly on server session
  const infos = (PadMessageHandler.sessioninfos || {}) as Record<string, any>;
  const session = infos[socket.id];
  if (session) session.readonly = isRO;

  // Send signal to client
  lumenSendReadOnly(socket, isRO, role);
};

exports.expressCreateServer = async (_hookName: string, args: ArgsExpressType, cb: Function) => {
  const padString =   eejs.require('ep_etherpad-lite/templates/padBootstrap.js', {
    pluginModules: (() => {
      const pluginModules = new Set();
      for (const part of plugins.parts) {
        for (const [, hookFnName] of Object.entries(part.client_hooks || {})) {
          // @ts-ignore
          pluginModules.add(hookFnName.split(':')[0]);
        }
      }
      return [...pluginModules];
    })(),
    settings,
  })

  const indexString = eejs.require('ep_etherpad-lite/templates/indexBootstrap.js', {
    settings,
  })

  const timeSliderString = eejs.require('ep_etherpad-lite/templates/timeSliderBootstrap.js', {
    pluginModules: (() => {
      const pluginModules = new Set();
      for (const part of plugins.parts) {
        for (const [, hookFnName] of Object.entries(part.client_hooks || {})) {
          // @ts-ignore
          pluginModules.add(hookFnName.split(':')[0]);
        }
      }
      return [...pluginModules];
    })(),
    settings,
  })



  // Lumen Docs — capture lumenToken from /p/:pad?lumenToken=... and cache role
  args.app.use('/p', async (req: any, _res: any, next: Function) => {
    const lumenToken = (req.query as any)?.lumenToken;
    if (lumenToken) {
      const data = lumenVerifyToken(lumenToken);
      if (data && data.padId && data.role) {
        const lumenUserId = data.userId || data.authorId;

        // Store role keyed by Lumen userId (for initial lookup before userJoin).
        // Do NOT store in lumenUserToAuthor here — the Lumen userId is NOT the
        // Etherpad authorId and would cause kick-user to miss the session.
        lumenRoleCache.set(`${data.padId}:${String(lumenUserId)}`, {
          role: data.role,
          userName: data.userName || null,
        });

        // Extract the real Etherpad authorId from the session cookie and use it
        // as the authoritative mapping for lumenUserToAuthor.
        try {
          const cookiePrefix = settings.cookie?.prefix || '';
          const authorToken = req.cookies?.[`${cookiePrefix}token`] || req.cookies?.token;
          if (authorToken) {
            const authorManager = require('../../handler/AuthorManager');
            const epAuthorId = await authorManager.getAuthorId(authorToken, null);
            if (epAuthorId) {
              // Store both directions: userId → authorId AND authorId → role
              lumenSetRole(data.padId, epAuthorId, data.role, data.userName, lumenUserId);
            }
          }
        } catch (e) {
          // authorManager not available yet, will be resolved in userJoin
        }
      }
    }
    next();
  });

  const outdir = path.join(settings.root, 'var','js')
  // Create the outdir if it doesn't exist
  if (!fs.existsSync(outdir)) {
    fs.mkdirSync(outdir);
  }

  let fileNamePad: string
  let fileNameTimeSlider: string
  let fileNameIndex: string
  if(process.env.NODE_ENV === "production"){
    const padSliderWrite = convertTypescript(padString)
    const timeSliderWrite = convertTypescript(timeSliderString)
    const indexWrite = convertTypescript(indexString)

    fileNamePad = `padbootstrap-${padSliderWrite.hash}.min.js`
    fileNameTimeSlider = `timeSliderBootstrap-${timeSliderWrite.hash}.min.js`
    fileNameIndex = `indexBootstrap-${indexWrite.hash}.min.js`

    args.app.get("/"+fileNamePad, (_req, res) => {
      res.header('Content-Type', 'application/javascript');
      res.send(padSliderWrite.output)
    })

    args.app.get("/"+fileNameIndex, (_req, res) => {
      res.header('Content-Type', 'application/javascript');
      res.send(indexWrite.output)
    })

    args.app.get("/"+fileNameTimeSlider, (_req, res) => {
      res.header('Content-Type', 'application/javascript');
      res.send(timeSliderWrite.output)
    })

    // serve index.html under /
    args.app.get('/', (req: any, res: any) => {
      const proxyPath = sanitizeProxyPath(req);
      varyOnProxyPath(res);
      const socialMetaHtml = renderSocialMeta({
        req, settings, availableLangs: i18n.availableLangs, locales: i18n.locales, kind: 'home',
        proxyPath,
      });
      res.send(eejs.require('ep_etherpad-lite/templates/index.html', {req, settings, entrypoint: "./"+fileNameIndex, socialMetaHtml, proxyPath}));
    });


    // serve pad.html under /p
    args.app.get('/p/:pad', (req: any, res: any, next: Function) => {
      // Lumen Docs — si l'URL d'intégration porte un token author stable
      // (`?token=t.xxx`), le poser comme cookie author avant la lecture par
      // ensureAuthorTokenCookie. La session Etherpad utilisera alors l'authorID
      // lié à ce token, ce qui permet à lumens de cibler précisément la session
      // d'un utilisateur lors d'une révocation du droit de saisie.
      const qToken = req.query?.token;
      const tokenName = `${settings.cookie?.prefix || ''}token`;
      if (typeof qToken === 'string' && padutils.isValidAuthorToken(qToken)) {
        // Pré-remplit req.cookies afin que ensureAuthorTokenCookie (qui lit
        // req.cookies.token) retourne ce token sans en régénérer un nouveau.
        (req.cookies ??= {})[tokenName] = qToken;
        res.cookie(tokenName, qToken, {
          httpOnly: true,
          secure: Boolean(req.secure),
          sameSite: req.headers?.['sec-fetch-site'] === 'cross-site' ? 'none' : 'lax',
          maxAge: 60 * 24 * 60 * 60 * 1000,
          path: '/',
        });
      }
      ensureAuthorTokenCookie(req, res, settings);
      // The below might break for pads being rewritten
      const isReadOnly = !webaccess.userCanModify(req.params.pad, req);

      hooks.callAll('padInitToolbar', {
        toolbar,
        isReadOnly
      });

      const proxyPath = sanitizeProxyPath(req);
      varyOnProxyPath(res);
      const socialMetaHtml = renderSocialMeta({
        req, settings, availableLangs: i18n.availableLangs, locales: i18n.locales, kind: 'pad', padName: req.params.pad,
        proxyPath,
      });
      const content = eejs.require('ep_etherpad-lite/templates/pad.html', {
        req,
        toolbar,
        isReadOnly,
        entrypoint: "../"+fileNamePad,
        settings: settings.getPublicSettings(),
        socialMetaHtml,
        proxyPath,
      })
      res.send(content);
    });

    // serve timeslider.html under /p/$padname/timeslider
    args.app.get('/p/:pad/timeslider', (req: any, res: any, next: Function) => {
      // Direct visits (legacy bookmarks) get redirected back to the pad,
      // where the in-pad PadModeController handles entering history mode.
      // The iframe used by history mode requests this URL with ?embed=1
      // and gets the full timeslider HTML rendered for embedded use.
      if (req.query.embed !== '1') {
        // Absolute path (not relative `../`) so Firefox and Chrome resolve
        // it identically — relative redirects from /p/:pad/timeslider are
        // technically well-defined but Firefox dropped a trailing-slash
        // case once that flaked the legacy-URL test (#7710).
        const proxyPath = sanitizeProxyPath(req);
        varyOnProxyPath(res);
        return res.redirect(302, `${proxyPath}/p/${encodeURIComponent(req.params.pad)}`);
      }
      ensureAuthorTokenCookie(req, res, settings);
      hooks.callAll('padInitToolbar', {
        toolbar,
      });

      const proxyPath = sanitizeProxyPath(req);
      varyOnProxyPath(res);
      const socialMetaHtml = renderSocialMeta({
        req, settings, availableLangs: i18n.availableLangs, locales: i18n.locales, kind: 'timeslider', padName: req.params.pad,
        proxyPath,
      });
      res.send(eejs.require('ep_etherpad-lite/templates/timeslider.html', {
        req,
        toolbar,
        embed: true,
        entrypoint: "../../"+fileNameTimeSlider,
        settings: settings.getPublicSettings(),
        socialMetaHtml,
        proxyPath,
      }));
    });
  } else {
    await handleLiveReload(args, padString, timeSliderString, indexString)
  }

  // The client occasionally polls this endpoint to get an updated expiration for the express_sid
  // cookie. This handler must be installed after the express-session middleware.
  args.app.put('/_extendExpressSessionLifetime', (req: any, res: any) => {
    // express-session automatically calls req.session.touch() so we don't need to do it here.
    res.json({status: 'ok'});
  });
};
