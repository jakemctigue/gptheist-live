import { randomUUID } from "node:crypto";
import { MongoClient, type Db, type Document } from "mongodb";

export interface ResearchExperiment extends Document {
  _id: string; phase: "CALIBRATION" | "CONFIRMATION"; rulesHash: string;
  rules: Record<string, unknown>; createdAt: string; parentId: string | null;
  confirmationDesign: { minimumDays: number; minimumClosedTrades: number; automaticPromotion: false };
}
export interface ResearchState extends Document {
  _id: string; revision: number; leaseOwner: string | null; leaseUntil: Date;
  lastBucket: number | null; candleDay: string | null; payload: Record<string, unknown>;
}
export interface ResearchEvent extends Document { _id: string; experimentId: string; kind: string; at: string }
export const researchCollections = {
  experiments: "research_experiments_v1", states: "research_states_v1", events: "research_events_v1"
} as const;

/** Immutable experiment and append-only evidence; only the resumable state projection is mutable. */
export class ResearchStore {
  readonly owner = randomUUID();
  constructor(readonly client: MongoClient, readonly db: Db) {}
  async indexes(): Promise<void> {
    await this.db.collection(researchCollections.events).createIndex({ experimentId: 1, kind: 1, at: 1 });
    // Intentionally no TTL: evidence must outlive calibration and the complete confirmation period.
  }
  async ensureExperiment(experiment: ResearchExperiment): Promise<ResearchExperiment> {
    await this.db.collection<ResearchExperiment>(researchCollections.experiments).updateOne({ _id: experiment._id }, { $setOnInsert: experiment }, { upsert: true });
    const stored = await this.experiment(experiment._id);
    if (!stored || stored.rulesHash !== experiment.rulesHash || stored.phase !== experiment.phase) throw new Error("RESEARCH_RULES_CHANGED_USE_NEW_EXPERIMENT");
    await this.db.collection<ResearchState>(researchCollections.states).updateOne({ _id: stored._id }, {
      $setOnInsert: { _id: stored._id, revision: 0, leaseOwner: null, leaseUntil: new Date(0), lastBucket: null, candleDay: null, payload: {} }
    }, { upsert: true });
    return stored;
  }
  experiment(id: string): Promise<ResearchExperiment | null> { return this.db.collection<ResearchExperiment>(researchCollections.experiments).findOne({ _id: id }); }
  state(id: string): Promise<ResearchState | null> { return this.db.collection<ResearchState>(researchCollections.states).findOne({ _id: id }); }
  async acquire(id: string, now = new Date()): Promise<ResearchState | null> {
    return this.db.collection<ResearchState>(researchCollections.states).findOneAndUpdate({ _id: id, leaseUntil: { $lte: now } }, {
      $set: { leaseOwner: this.owner, leaseUntil: new Date(now.getTime() + 300_000) }
    }, { returnDocument: "after" });
  }
  async commit(previous: ResearchState, payload: Record<string, unknown>, bucket: number, candleDay: string | null, events: ResearchEvent[]): Promise<void> {
    const session = this.client.startSession();
    try {
      await session.withTransaction(async () => {
        const result = await this.db.collection<ResearchState>(researchCollections.states).updateOne({
          _id: previous._id, revision: previous.revision, leaseOwner: this.owner, leaseUntil: { $gt: new Date() }
        }, { $set: { payload, lastBucket: bucket, candleDay, leaseOwner: null, leaseUntil: new Date(0) }, $inc: { revision: 1 } }, { session });
        if (result.modifiedCount !== 1) throw new Error("RESEARCH_LEASE_LOST");
        if (events.length) await this.db.collection<ResearchEvent>(researchCollections.events).insertMany(events, { session });
      });
    } finally { await session.endSession(); }
  }
  async release(id: string): Promise<void> {
    await this.db.collection<ResearchState>(researchCollections.states).updateOne({ _id: id, leaseOwner: this.owner }, { $set: { leaseOwner: null, leaseUntil: new Date(0) } });
  }
  async events(id: string, kind: string, limit = 100): Promise<ResearchEvent[]> {
    return this.db.collection<ResearchEvent>(researchCollections.events).find({ experimentId: id, kind }).sort({ at: -1 }).limit(limit).toArray();
  }
}
