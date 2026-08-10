/**
 * Automation Home Anchors Repository
 *
 * CRUD for `automation_home_anchors` — per-(automation, node) home positions
 * used by `trigger.leftHome`. GLOBAL (no sourceId), matching automations.
 */
import { and, eq } from 'drizzle-orm';
import { BaseRepository, DrizzleDatabase } from './base.js';
import { DatabaseType } from '../types.js';

export interface AutomationHomeAnchor {
  id: number;
  automationId: string;
  nodeNum: number;
  latitude: number;
  longitude: number;
  setAt: number;
}

export class AutomationHomeAnchorsRepository extends BaseRepository {
  constructor(db: DrizzleDatabase, dbType: DatabaseType) {
    super(db, dbType);
  }

  private get table() {
    return this.tables.automationHomeAnchors;
  }

  private rowToRecord(row: any): AutomationHomeAnchor {
    return {
      id: Number(row.id),
      automationId: String(row.automationId),
      nodeNum: Number(row.nodeNum),
      latitude: Number(row.latitude),
      longitude: Number(row.longitude),
      setAt: Number(row.setAt),
    };
  }

  async getAnchor(automationId: string, nodeNum: number): Promise<AutomationHomeAnchor | null> {
    const t = this.table;
    const rows = await this.db
      .select()
      .from(t)
      .where(and(eq(t.automationId, automationId), eq(t.nodeNum, nodeNum)))
      .limit(1);
    return rows[0] ? this.rowToRecord(rows[0]) : null;
  }

  async upsertAnchor(
    automationId: string,
    nodeNum: number,
    latitude: number,
    longitude: number,
    setAt: number = Date.now(),
  ): Promise<void> {
    const existing = await this.getAnchor(automationId, nodeNum);
    const t = this.table;
    if (existing) {
      await this.db
        .update(t)
        .set({ latitude, longitude, setAt })
        .where(and(eq(t.automationId, automationId), eq(t.nodeNum, nodeNum)));
      return;
    }
    await this.db.insert(t).values({
      automationId,
      nodeNum,
      latitude,
      longitude,
      setAt,
    });
  }

  async deleteAnchor(automationId: string, nodeNum: number): Promise<void> {
    const t = this.table;
    await this.db
      .delete(t)
      .where(and(eq(t.automationId, automationId), eq(t.nodeNum, nodeNum)));
  }

  async deleteByAutomation(automationId: string): Promise<void> {
    const t = this.table;
    await this.db.delete(t).where(eq(t.automationId, automationId));
  }
}
