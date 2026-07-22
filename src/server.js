'use strict';

const path = require('path');
const express = require('express');
const { searchAlerts, countAlerts, getAlertRawXml, getResourceById, stats } = require('./db');

// Query params arrive as strings; only an explicit truthy value should
// activate one of these "only show flagged alerts" filters.
function parseBoolParam(v) {
  return /^(1|true|yes)$/i.test(v || '') || undefined;
}

function createServer() {
  const app = express();
  app.use(express.static(path.join(__dirname, '..', 'public')));

  app.get('/api/stats', async (req, res) => {
    try {
      res.json(await stats());
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/search', async (req, res) => {
    const { q, event, severity, urgency, status, from, to, language } = req.query;
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
    const offset = parseInt(req.query.offset, 10) || 0;
    const broadcastImmediate = parseBoolParam(req.query.broadcastImmediate);
    const wirelessImmediate = parseBoolParam(req.query.wirelessImmediate);
    const filters = { q, event, severity, urgency, status, from, to, language, broadcastImmediate, wirelessImmediate };
    try {
      const results = await searchAlerts({ ...filters, limit, offset });
      const total = await countAlerts(filters);
      res.json({ count: results.length, total, limit, offset, results });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  app.get('/api/alert/:id/xml', async (req, res) => {
    try {
      const xml = await getAlertRawXml(req.params.id);
      if (!xml) return res.status(404).send('Not found');
      res.type('application/xml').send(xml);
    } catch (err) {
      res.status(500).send(err.message);
    }
  });

  // Serves a CAP <resource> attachment (e.g. broadcast audio) referenced
  // from a search result. Embedded (base64) resources are streamed
  // directly; resources that were only linked by external URL are
  // redirected there instead of proxied.
  app.get('/api/resource/:id', async (req, res) => {
    try {
      const resource = await getResourceById(req.params.id);
      if (!resource) return res.status(404).send('Not found');
      if (resource.data) {
        res.type(resource.mime_type || 'application/octet-stream');
        res.send(resource.data);
      } else if (resource.uri) {
        res.redirect(resource.uri);
      } else {
        res.status(404).send('No data available for this resource');
      }
    } catch (err) {
      res.status(500).send(err.message);
    }
  });

  return app;
}

function startServer(port = process.env.PORT || 3000) {
  const app = createServer();
  return app.listen(port, () => console.log(`[server] search UI at http://localhost:${port}`));
}

module.exports = { createServer, startServer };
