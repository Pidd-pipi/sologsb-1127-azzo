import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { InspectionConclusion } from '../types/inspection';
import type { RectifyStatus } from '../types/rectify';
import type { FacilityType } from '../types/point';

export interface InspectionFilter {
  district: string;
  facilityType: FacilityType | '';
  conclusion: InspectionConclusion | '';
  fromDate: string;
  toDate: string;
  keyword: string;
}

export const EMPTY_FILTER: InspectionFilter = {
  district: '',
  facilityType: '',
  conclusion: '',
  fromDate: '',
  toDate: '',
  keyword: '',
};

interface UiState {
  filter: InspectionFilter;
  /** 总览页下钻：点击统计块后展示的清单维度 */
  drill: { kind: 'district' | 'facilityType' | 'pending' | ''; value: string };
  rectifyStatus: RectifyStatus | '';
  selectedPointId: string;
  mapFacilityFilter: FacilityType | '';
  mapKeyword: string;
  setFilter: (patch: Partial<InspectionFilter>) => void;
  resetFilter: () => void;
  setDrill: (kind: 'district' | 'facilityType' | 'pending' | '', value: string) => void;
  setRectifyStatus: (status: RectifyStatus | '') => void;
  setSelectedPointId: (id: string) => void;
  setMapFacilityFilter: (t: FacilityType | '') => void;
  setMapKeyword: (keyword: string) => void;
}

/** UI 偏好走 localStorage 持久化（zustand persist），业务数据走 IndexedDB */
export const useUiStore = create<UiState>()(
  persist(
    (set) => ({
      filter: { ...EMPTY_FILTER },
      drill: { kind: '', value: '' },
      rectifyStatus: '',
      selectedPointId: '',
      mapFacilityFilter: '',
      mapKeyword: '',
      setFilter: (patch) => set((s) => ({ filter: { ...s.filter, ...patch } })),
      resetFilter: () => set({ filter: { ...EMPTY_FILTER } }),
      setDrill: (kind, value) => set({ drill: { kind, value } }),
      setRectifyStatus: (status) => set({ rectifyStatus: status }),
      setSelectedPointId: (id) => set({ selectedPointId: id }),
      setMapFacilityFilter: (t) => set({ mapFacilityFilter: t }),
      setMapKeyword: (keyword) => set({ mapKeyword: keyword }),
    }),
    {
      name: 'gbaccessmap-ui',
      version: 1,
      migrate: (persisted) => {
        const state = (persisted ?? {}) as Partial<UiState>;
        return {
          ...state,
          filter: { ...EMPTY_FILTER, ...(state.filter ?? {}) },
          mapKeyword: state.mapKeyword ?? '',
        };
      },
    },
  ),
);
