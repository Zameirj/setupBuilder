import { Injectable } from '@angular/core';
import { invoke } from '@tauri-apps/api/core';
import { listen, UnlistenFn } from '@tauri-apps/api/event';
import { open } from '@tauri-apps/plugin-dialog';

export interface Product {
  productId: string;
  name: string;
  version: string | null;
  priority: string | null;
  description: string | null;
  type: string | null;
  notification: string | null;
  parentProductId: string | null;
  friendlyName: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface Settings {
  apiKey: string;
  apiUrl: string;
}

export interface BuildJob {
  productId: string;
  /** Absolute paths to files and/or folders. */
  sources: string[];
  /** Written to "version" in the selected package.json before compressing. */
  version: string;
}

export type BuildStatus = 'idle' | 'queued' | 'building' | 'done' | 'error';

export interface BuildProgress {
  productId: string;
  status: Exclude<BuildStatus, 'idle' | 'queued'>;
  message: string;
  outputPath: string | null;
}

export interface UpdateInfo {
  version: string;
  downloadUrl: string | null;
  notes: string | null;
}

export interface BuildSummary {
  succeeded: number;
  failed: number;
}

@Injectable({ providedIn: 'root' })
export class TauriService {
  getSettings(): Promise<Settings> {
    return invoke<Settings>('get_settings');
  }

  saveSettings(settings: Settings): Promise<void> {
    return invoke('save_settings', { settings });
  }

  fetchProducts(): Promise<Product[]> {
    return invoke<Product[]>('fetch_products');
  }

  passwordFor(productId: string): Promise<string> {
    return invoke<string>('password_for', { productId });
  }

  buildProducts(jobs: BuildJob[], outputDir: string): Promise<BuildSummary> {
    return invoke<BuildSummary>('build_products', { jobs, outputDir });
  }

  checkForUpdate(url: string, sendApiKey: boolean): Promise<UpdateInfo> {
    return invoke<UpdateInfo>('check_for_update', { url, sendApiKey });
  }

  openFolder(path: string): Promise<void> {
    return invoke('open_folder', { path });
  }

  onBuildProgress(handler: (p: BuildProgress) => void): Promise<UnlistenFn> {
    return listen<BuildProgress>('build-progress', (e) => handler(e.payload));
  }

  async pickFolder(title: string, defaultPath?: string): Promise<string | null> {
    const result = await open({ directory: true, multiple: false, title, defaultPath });
    return typeof result === 'string' ? result : null;
  }

  async pickFiles(title: string, defaultPath?: string): Promise<string[]> {
    const result = await open({ directory: false, multiple: true, title, defaultPath });
    if (!result) return [];
    return Array.isArray(result) ? result : [result];
  }
}
