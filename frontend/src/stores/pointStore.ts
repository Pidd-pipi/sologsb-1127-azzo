import { create } from 'zustand';
import { db, ensureSeed } from '../db';
import type { AccessPoint, AccessPointDraft } from '../types/point';
import type { Inspection, InspectionDraft } from '../types/inspection';
import type { RectifyPlan, RectifyPlanDraft } from '../types/rectify';
import type { RouteSegment } from '../types/route';
import { useRouteStore } from './routeStore';
import { makeId, toPlain, todayStr } from '../utils/format';

interface PointState {
  /** 保留点（未并入别处），地图与总览只消费这一份 */
  points: AccessPoint[];
  /** 已并入保留点的历史记录，保留原编号用于检索跳转 */
  tombstones: AccessPoint[];
  inspections: Inspection[];
  rectifies: RectifyPlan[];
  loading: boolean;
  loaded: boolean;
  error: string;
  load: () => Promise<void>;
  addPoint: (draft: AccessPointDraft) => Promise<AccessPoint>;
  addInspection: (draft: InspectionDraft) => Promise<Inspection>;
  addRectify: (draft: RectifyPlanDraft) => Promise<RectifyPlan>;
  updateRectify: (id: string, patch: Partial<RectifyPlan>) => Promise<void>;
  /**
   * 把当前记录 sourceId 并入 targetId：
   * 核验历史、整改条目与路线端点一并转到保留点，
   * 原编号作为别名保留，地图与总览不再把它当成第二个设施。
   * 重复执行幂等：已经并入的记录直接返回既有保留点，不再产生副本。
   */
  mergePoint: (sourceId: string, targetId: string) => Promise<AccessPoint>;
  getPoint: (id: string) => AccessPoint | undefined;
  /** 按 id / 编号 / 别名解析到当前有效（保留）点位，跟随并入链 */
  resolvePoint: (idOrCode: string) => AccessPoint | undefined;
  /** 解析最终落在某保留点上的已并入记录（用于详情页提示来源） */
  getMergedRecord: (idOrCode: string) => AccessPoint | undefined;
  inspectionsOf: (pointId: string) => Inspection[];
  rectifiesOf: (pointId: string) => RectifyPlan[];
}

function sortByCode(list: AccessPoint[]): AccessPoint[] {
  return [...list].sort((a, b) => a.code.localeCompare(b.code));
}

/** 并入时把来源编号并入别名列表，去重（大小写不敏感）并保持顺序 */
function mergeAliases(existing: string[] | undefined, additions: string[]): string[] {
  const out = [...(existing ?? [])];
  const seen = new Set(out.map((c) => c.trim().toUpperCase()));
  for (const code of additions) {
    const c = code.trim();
    if (!c || seen.has(c.toUpperCase())) continue;
    seen.add(c.toUpperCase());
    out.push(c);
  }
  return out;
}

export const usePointStore = create<PointState>((set, get) => ({
  points: [],
  tombstones: [],
  inspections: [],
  rectifies: [],
  loading: false,
  loaded: false,
  error: '',

  load: async () => {
    set({ loading: true, error: '' });
    try {
      await ensureSeed();
      const [allPoints, inspections, rectifies] = await Promise.all([
        db.points.toArray(),
        db.inspections.toArray(),
        db.rectifies.toArray(),
      ]);
      set({
        points: sortByCode(allPoints.filter((p) => !p.mergedIntoId)),
        tombstones: allPoints
          .filter((p) => Boolean(p.mergedIntoId))
          .sort((a, b) => a.code.localeCompare(b.code)),
        inspections: inspections.sort((a, b) => (a.date < b.date ? 1 : -1)),
        rectifies: [...rectifies].sort((a, b) => (a.deadline < b.deadline ? -1 : 1)),
        loading: false,
        loaded: true,
      });
    } catch (e) {
      set({ loading: false, loaded: true, error: e instanceof Error ? e.message : String(e) });
    }
  },

  addPoint: async (draft) => {
    const now = new Date().toISOString();
    const point: AccessPoint = toPlain({
      ...draft,
      id: makeId('pt'),
      createdAt: now,
      updatedAt: now,
    });
    await db.points.put(point);
    set((s) => ({ points: sortByCode([...s.points, point]) }));
    return point;
  },

  addInspection: async (draft) => {
    const inspection: Inspection = toPlain({
      ...draft,
      id: makeId('ins'),
      createdAt: new Date().toISOString(),
    });
    await db.inspections.put(inspection);
    set((s) => ({
      inspections: [inspection, ...s.inspections].sort((a, b) => (a.date < b.date ? 1 : -1)),
    }));
    // 结论为不合格时自动生成整改条目，形成闭环
    if (inspection.conclusion === '不合格') {
      const exists = get().rectifies.some(
        (r) => r.pointId === inspection.pointId && r.status !== '已整改',
      );
      if (!exists) {
        await get().addRectify({
          pointId: inspection.pointId,
          requirement: `按 ${inspection.date} 核验结论整改：${inspection.problem || '坡度、净宽或占用问题'}`,
          unit: '待指派责任单位',
          deadline: todayStr(),
          recheckDate: '',
          status: '待整改',
        });
      }
    }
    return inspection;
  },

  addRectify: async (draft) => {
    const plan: RectifyPlan = toPlain({
      ...draft,
      id: makeId('rct'),
      createdAt: new Date().toISOString(),
    });
    await db.rectifies.put(plan);
    set((s) => ({
      rectifies: [...s.rectifies, plan].sort((a, b) => (a.deadline < b.deadline ? -1 : 1)),
    }));
    return plan;
  },

  updateRectify: async (id, patch) => {
    const plain = toPlain(patch);
    await db.rectifies.update(id, plain);
    set((s) => ({
      rectifies: s.rectifies.map((r) => (r.id === id ? { ...r, ...plain } : r)),
    }));
  },

  mergePoint: async (sourceId, targetId) => {
    if (!sourceId || !targetId) {
      throw new Error('并入来源与保留点均不能为空');
    }
    if (sourceId === targetId) {
      throw new Error('不能并入点位自身');
    }
    const { points, tombstones } = get();
    const source = [...points, ...tombstones].find((p) => p.id === sourceId);
    if (!source) throw new Error('来源点位不存在或已被移除');
    const target = points.find((p) => p.id === targetId);
    if (!target) throw new Error('保留点位不存在或已并入其他点位');

    // 幂等：来源已经并入该保留点，直接返回，不重复搬运
    if (source.mergedIntoId === target.id) {
      return target;
    }
    // 来源已是历史记录但指向别处：跟随其并入链，不允许二次分裂
    if (source.mergedIntoId) {
      return get().resolvePoint(source.mergedIntoId) ?? target;
    }

    const mergedAt = new Date().toISOString();
    // 保留点继承来源编号及其历史别名
    const aliases = mergeAliases(target.aliases, [source.code, ...(source.aliases ?? [])]);

    await db.transaction('rw', db.points, db.inspections, db.routes, db.rectifies, async () => {
      // 1) 核验历史整体转到保留点（逐条实测记录均保留，状态不变）
      await db.inspections.where('pointId').equals(sourceId).modify({ pointId: targetId });

      // 2) 整改条目转到保留点，双方原有整改状态各自保留
      await db.rectifies.where('pointId').equals(sourceId).modify({ pointId: targetId });

      // 3) 路线端点转到保留点；端点重合后清掉自环段与同路线重复段并重排序号
      const linked: RouteSegment[] = await db.routes
        .where('fromPointId')
        .equals(sourceId)
        .or('toPointId')
        .equals(sourceId)
        .toArray();
      if (linked.length) {
        const touchedRoutes = new Set<string>();
        const renamed: RouteSegment[] = linked.map((seg) => ({
          ...seg,
          fromPointId: seg.fromPointId === sourceId ? targetId : seg.fromPointId,
          toPointId: seg.toPointId === sourceId ? targetId : seg.toPointId,
        }));
        const selfLoopIds = new Set(renamed.filter((s) => s.fromPointId === s.toPointId).map((s) => s.id));
        for (const seg of renamed) touchedRoutes.add(seg.routeName);

        // 同一路线内端点完全一致的重复段（并入前两条并行记录）只保留一条
        const existingAfter = await db.routes.where('routeName').anyOf([...touchedRoutes]).toArray();
        const seenKey = new Map<string, string>();
        for (const seg of existingAfter) {
          if (seg.fromPointId === sourceId || seg.toPointId === sourceId) continue;
          const key = `${seg.fromPointId}->${seg.toPointId}`;
          if (!seenKey.has(key)) seenKey.set(key, seg.id);
        }
        const duplicateIds = new Set<string>();
        for (const seg of renamed) {
          const key = `${seg.fromPointId}->${seg.toPointId}`;
          const keepId = seenKey.get(key);
          if (keepId && keepId !== seg.id) {
            duplicateIds.add(seg.id);
          } else if (!keepId) {
            seenKey.set(key, seg.id);
          }
        }
        const deleteIds = new Set([...selfLoopIds, ...duplicateIds]);

        await db.routes.bulkPut(renamed.filter((s) => !deleteIds.has(s.id)));
        if (deleteIds.size) await db.routes.bulkDelete([...deleteIds]);

        // 受影响路线重新连续编号
        for (const routeName of touchedRoutes) {
          const segs = (await db.routes.where('routeName').equals(routeName).toArray()).sort(
            (a, b) => a.order - b.order,
          );
          for (let i = 0; i < segs.length; i += 1) {
            if (segs[i].order !== i + 1) {
              await db.routes.update(segs[i].id, { order: i + 1 });
            }
          }
        }
      }

      // 4) 来源点位落为历史记录：原编号保留在记录上，保留点以别名收录
      const tombstone: AccessPoint = toPlain({
        ...source,
        aliases: [],
        mergedIntoId: targetId,
        mergedAt,
        updatedAt: mergedAt,
      });
      const updatedTarget: AccessPoint = toPlain({
        ...target,
        aliases,
        updatedAt: mergedAt,
      });
      await db.points.put(tombstone);
      await db.points.put(updatedTarget);
    });

    // 5) 同步内存态（以库内最新数据为准，避免重复点击期间读到旧快照）
    const [allPoints, inspections, rectifies] = await Promise.all([
      db.points.toArray(),
      db.inspections.toArray(),
      db.rectifies.toArray(),
    ]);
    set({
      points: sortByCode(allPoints.filter((p) => !p.mergedIntoId)),
      tombstones: allPoints
        .filter((p) => Boolean(p.mergedIntoId))
        .sort((a, b) => a.code.localeCompare(b.code)),
      inspections: inspections.sort((a, b) => (a.date < b.date ? 1 : -1)),
      rectifies: [...rectifies].sort((a, b) => (a.deadline < b.deadline ? -1 : 1)),
    });
    // 路线端点已改写，刷新路线编制页数据
    await useRouteStore.getState().load();

    return get().points.find((p) => p.id === targetId) ?? target;
  },

  getPoint: (id) => get().points.find((p) => p.id === id),

  resolvePoint: (idOrCode) => {
    const key = idOrCode.trim();
    if (!key) return undefined;
    const { points, tombstones } = get();
    const direct = points.find((p) => p.id === key);
    if (direct) return direct;

    const matchCode = (p: AccessPoint) =>
      p.code.trim().toUpperCase() === key.toUpperCase() ||
      (p.aliases ?? []).some((a) => a.trim().toUpperCase() === key.toUpperCase());

    const activeByCode = points.find(matchCode);
    if (activeByCode) return activeByCode;

    // 跟随并入链（含多次并入），直到找到当前保留点
    let record = tombstones.find((p) => p.id === key) ?? tombstones.find(matchCode);
    const guard = new Set<string>();
    while (record?.mergedIntoId && !guard.has(record.id)) {
      guard.add(record.id);
      const nextId = record.mergedIntoId;
      const next = points.find((p) => p.id === nextId) ?? tombstones.find((p) => p.id === nextId);
      if (!next) break;
      if (!next.mergedIntoId) return next;
      record = next;
    }
    return undefined;
  },

  getMergedRecord: (idOrCode) => {
    const key = idOrCode.trim();
    const { tombstones } = get();
    return (
      tombstones.find((p) => p.id === key) ??
      tombstones.find(
        (p) =>
          p.code.trim().toUpperCase() === key.toUpperCase() ||
          (p.aliases ?? []).some((a) => a.trim().toUpperCase() === key.toUpperCase()),
      )
    );
  },

  inspectionsOf: (pointId) =>
    get()
      .inspections.filter((i) => i.pointId === pointId)
      .sort((a, b) => (a.date < b.date ? 1 : -1)),

  rectifiesOf: (pointId) =>
    get()
      .rectifies.filter((r) => r.pointId === pointId)
      .sort((a, b) => (a.deadline < b.deadline ? -1 : 1)),
}));
