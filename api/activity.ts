import { list } from '@vercel/blob';

// Activity Feed API — returns recent webhook hits and alert activity
// GET /api/activity          → last 50 activity entries
// GET /api/activity?alerts=1 → unique alert symbols with last trigger + count

export default async function handler(req: any, res: any) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const blobs = await list({ prefix: 'activity/' });

    // Read all activity records
    const activities: any[] = [];
    for (const blob of blobs.blobs) {
      try {
        const r = await fetch(blob.url);
        const data = (await r.json()) as any;
        activities.push(data);
      } catch {}
    }

    // Sort newest first
    activities.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

    // Alerts summary mode — unique symbols with last trigger time and counts
    if (req.query?.alerts === '1') {
      const alertMap: Record<string, {
        symbol: string;
        lastTrigger: string;
        totalHits: number;
        buys: number;
        sells: number;
        lastSignal: string;
        lastSide: string;
        status: 'active' | 'idle';
      }> = {};

      for (const a of activities) {
        const sym = a.symbol || 'UNKNOWN';
        if (!alertMap[sym]) {
          alertMap[sym] = {
            symbol: sym,
            lastTrigger: a.timestamp,
            totalHits: 0,
            buys: 0,
            sells: 0,
            lastSignal: a.signal || 'unknown',
            lastSide: a.side || 'Buy',
            status: 'active',
          };
        }
        alertMap[sym].totalHits++;
        if (a.side === 'Buy') alertMap[sym].buys++;
        if (a.side === 'Sell') alertMap[sym].sells++;
      }

      // Mark as idle if no trigger in last 24h
      const now = Date.now();
      for (const key of Object.keys(alertMap)) {
        const lastTime = new Date(alertMap[key].lastTrigger).getTime();
        if (now - lastTime > 24 * 60 * 60 * 1000) {
          alertMap[key].status = 'idle';
        }
      }

      const alerts = Object.values(alertMap).sort((a, b) =>
        new Date(b.lastTrigger).getTime() - new Date(a.lastTrigger).getTime()
      );

      return res.status(200).json({ success: true, alerts, total: alerts.length });
    }

    // Default: return last 50 activity entries
    const limited = activities.slice(0, 50);
    return res.status(200).json({ success: true, activities: limited, total: activities.length });
  } catch (err: any) {
    console.error('Activity API error:', err.message);
    return res.status(500).json({ error: err.message || 'Activity error' });
  }
}
