import { type UserSettings, SETTING_DEFAULTS } from "./settings-model.ts";
import { $ } from "./utils.ts";

export interface BucketInfo {
  name: string;
  creation_date: string;
}

export interface ObjectInfo {
  key: string;
  size: number;
  last_modified: string;
  is_folder: boolean;
}

export const state = {
  currentSettings: { ...SETTING_DEFAULTS } as UserSettings,
  lastPersistedSettings: { ...SETTING_DEFAULTS } as UserSettings,
  settingsExtras: {} as Record<string, unknown>,
  connected: false,
  connecting: false,
  endpoint: "",
  region: "",
  currentBucket: "",
  currentPrefix: "",
  buckets: [] as BucketInfo[],
  objects: [] as ObjectInfo[],
  prefixes: [] as string[],
  selectedKeys: new Set<string>(),
  continuationToken: "",
  hasMore: false,
  sortColumn: "name" as "name" | "size" | "modified",
  sortAsc: true,
  filterText: "",
  platformName: "",
  statusTimeout: undefined as ReturnType<typeof setTimeout> | undefined,
};

export const dom = {
  get app() {
    return $("app");
  },
  get bucketList() {
    return $("bucket-list");
  },
  get objectTbody() {
    return $("object-tbody");
  },
  get breadcrumb() {
    return $("breadcrumb");
  },
  get statusEl() {
    return $("status");
  },
  get versionLabel() {
    return $("version-label");
  },
  get connectBtn() {
    return $<HTMLButtonElement>("connect-btn");
  },
  get disconnectBtn() {
    return $<HTMLButtonElement>("disconnect-btn");
  },
  get connectionStatus() {
    return $("connection-status");
  },
  get emptyState() {
    return $("empty-state");
  },
  get objectPanel() {
    return $("object-panel");
  },
  get bucketPanel() {
    return $("bucket-panel");
  },
};
