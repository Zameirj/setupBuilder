import { Component, computed, inject, OnDestroy, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatDialog } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule, MatIconRegistry } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatSnackBar } from '@angular/material/snack-bar';
import { MatToolbarModule } from '@angular/material/toolbar';
import { MatTooltipModule } from '@angular/material/tooltip';
import { getVersion } from '@tauri-apps/api/app';
import { UnlistenFn } from '@tauri-apps/api/event';
import { openUrl } from '@tauri-apps/plugin-opener';
import { firstValueFrom } from 'rxjs';
import { ProductRow } from './product-row/product-row';
import { SettingsDialog } from './settings-dialog/settings-dialog';
import { BuildStatus, Product, Settings, TauriService, UpdateInfo } from './tauri.service';
import { compareVersions, UPDATE_CHECK_URL, UPDATE_DOWNLOAD_URL, UPDATE_SEND_API_KEY } from './update-config';

const SOURCES_KEY = 'setupBuilder.sources';
const LEGACY_SOURCE_DIRS_KEY = 'setupBuilder.sourceDirs';
const OUTPUT_DIR_KEY = 'setupBuilder.outputDir';

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage unavailable; selections just won't persist */
  }
}

/** Per-product selected paths; migrates the earlier folder-only format. */
function loadSources(): Record<string, string[]> {
  const sources = readJson<Record<string, string[]>>(SOURCES_KEY, {});
  const legacy = readJson<Record<string, string>>(LEGACY_SOURCE_DIRS_KEY, {});
  for (const [id, dir] of Object.entries(legacy)) {
    if (!sources[id] && dir) sources[id] = [dir];
  }
  return sources;
}

@Component({
  selector: 'app-root',
  imports: [
    FormsModule,
    MatButtonModule,
    MatFormFieldModule,
    MatIconModule,
    MatInputModule,
    MatProgressBarModule,
    MatToolbarModule,
    MatTooltipModule,
    ProductRow,
  ],
  templateUrl: './app.html',
  styleUrl: './app.scss',
})
export class App implements OnInit, OnDestroy {
  private readonly tauri = inject(TauriService);
  private readonly dialog = inject(MatDialog);
  private readonly snack = inject(MatSnackBar);

  readonly products = signal<Product[]>([]);
  readonly loading = signal(false);
  readonly loadError = signal<string | null>(null);
  readonly filter = signal('');

  readonly sources = signal<Record<string, string[]>>(loadSources());
  readonly outputDir = signal<string>(readJson(OUTPUT_DIR_KEY, ''));
  readonly versions = signal<Record<string, string>>({});
  readonly selected = signal<Set<string>>(new Set());
  readonly statuses = signal<Record<string, { status: BuildStatus; message: string }>>({});
  readonly building = signal(false);
  readonly appVersion = signal('');
  readonly availableUpdate = signal<UpdateInfo | null>(null);
  readonly updateDismissed = signal(false);

  readonly visibleProducts = computed(() => {
    const q = this.filter().trim().toLowerCase();
    const list = this.products();
    if (!q) return list;
    return list.filter((p) => p.name.toLowerCase().includes(q) || p.productId.toLowerCase().includes(q));
  });

  readonly selectedCount = computed(() => this.selected().size);
  readonly canBuild = computed(() => this.selectedCount() > 0 && !!this.outputDir() && !this.building());

  private unlisten?: UnlistenFn;

  constructor() {
    inject(MatIconRegistry).setDefaultFontSetClass('material-symbols-outlined');
  }

  async ngOnInit(): Promise<void> {
    this.unlisten = await this.tauri.onBuildProgress((p) =>
      this.setStatus(p.productId, p.status, p.message),
    );

    this.appVersion.set(await getVersion());
    void this.checkForUpdate();

    const settings = await this.tauri.getSettings();
    if (!settings.apiKey) {
      const saved = await this.openSettings(settings);
      if (!saved) {
        this.loadError.set('No API key configured. Open Settings to add one.');
        return;
      }
    }
    await this.load();
  }

  ngOnDestroy(): void {
    this.unlisten?.();
  }

  async load(): Promise<void> {
    this.loading.set(true);
    this.loadError.set(null);
    try {
      const products = await this.tauri.fetchProducts();
      this.products.set(products);
      this.versions.set(Object.fromEntries(products.map((p) => [p.productId, p.version ?? ''])));
      this.statuses.set({});
      // Drop selections for products that no longer exist or have no folder.
      this.selected.update((s) => new Set([...s].filter((id) => this.hasSources(id) && products.some((p) => p.productId === id))));
    } catch (e) {
      this.loadError.set(String(e));
    } finally {
      this.loading.set(false);
    }
  }

  /** Asks the update endpoint for the latest version. Failures are silent. */
  async checkForUpdate(): Promise<void> {
    if (!UPDATE_CHECK_URL) return;
    try {
      const latest = await this.tauri.checkForUpdate(UPDATE_CHECK_URL, UPDATE_SEND_API_KEY);
      const isNewer = compareVersions(latest.version, this.appVersion()) > 0;
      this.availableUpdate.set(isNewer ? latest : null);
    } catch (e) {
      console.warn('Update check failed', e);
    }
  }

  async downloadUpdate(): Promise<void> {
    try {
      await openUrl(this.availableUpdate()?.downloadUrl || UPDATE_DOWNLOAD_URL);
    } catch (e) {
      this.snack.open(`Could not open download link: ${e}`, 'Close', { duration: 6000 });
    }
  }

  async editSettings(): Promise<void> {
    const current = await this.tauri.getSettings();
    if (await this.openSettings(current)) {
      await this.load();
    }
  }

  private async openSettings(current: Settings): Promise<boolean> {
    const ref = this.dialog.open<SettingsDialog, Settings, Settings>(SettingsDialog, {
      data: current,
      disableClose: !current.apiKey,
    });
    const result = await firstValueFrom(ref.afterClosed());
    if (!result) return false;
    await this.tauri.saveSettings(result);
    return true;
  }

  hasSources(productId: string): boolean {
    return (this.sources()[productId]?.length ?? 0) > 0;
  }

  async browseFiles(product: Product): Promise<void> {
    const files = await this.tauri.pickFiles(`Files to compress for ${product.name}`, this.lastDir(product));
    if (files.length) this.setSources(product, files);
  }

  async browseFolder(product: Product): Promise<void> {
    const dir = await this.tauri.pickFolder(`Folder to compress for ${product.name}`, this.lastDir(product));
    if (dir) this.setSources(product, [dir]);
  }

  clearSource(product: Product): void {
    this.sources.update((d) => {
      const { [product.productId]: _, ...rest } = d;
      return rest;
    });
    writeJson(SOURCES_KEY, this.sources());
    this.setSelected(product.productId, false);
  }

  private setSources(product: Product, paths: string[]): void {
    this.sources.update((d) => ({ ...d, [product.productId]: paths }));
    writeJson(SOURCES_KEY, this.sources());
    this.setSelected(product.productId, true);
  }

  /** Folder to open the picker in: the previous selection's location. */
  private lastDir(product: Product): string | undefined {
    const first = this.sources()[product.productId]?.[0];
    if (!first) return undefined;
    const idx = first.lastIndexOf('\\');
    return idx > 0 ? first.slice(0, idx) : first;
  }

  async browseOutput(): Promise<void> {
    const dir = await this.tauri.pickFolder('Output folder for built .exe files', this.outputDir() || undefined);
    if (!dir) return;
    this.outputDir.set(dir);
    writeJson(OUTPUT_DIR_KEY, dir);
  }

  async openOutput(): Promise<void> {
    try {
      await this.tauri.openFolder(this.outputDir());
    } catch (e) {
      this.snack.open(String(e), 'Close', { duration: 5000 });
    }
  }

  setSelected(productId: string, checked: boolean): void {
    this.selected.update((s) => {
      const next = new Set(s);
      if (checked) next.add(productId);
      else next.delete(productId);
      return next;
    });
  }

  selectAll(): void {
    this.selected.set(new Set(this.visibleProducts().filter((p) => this.hasSources(p.productId)).map((p) => p.productId)));
  }

  selectNone(): void {
    this.selected.set(new Set());
  }

  setVersion(productId: string, version: string): void {
    this.versions.update((v) => ({ ...v, [productId]: version }));
  }

  async copyPassword(product: Product): Promise<void> {
    const password = await this.tauri.passwordFor(product.productId);
    await navigator.clipboard.writeText(password);
    this.snack.open(`Password for ${product.name} copied`, undefined, { duration: 2500 });
  }

  private setStatus(productId: string, status: BuildStatus, message = ''): void {
    this.statuses.update((s) => ({ ...s, [productId]: { status, message } }));
  }

  async build(): Promise<void> {
    const sources = this.sources();
    const versions = this.versions();
    // Build in the order shown in the list.
    const jobs = this.products()
      .filter((p) => this.selected().has(p.productId) && this.hasSources(p.productId))
      .map((p) => ({ productId: p.productId, sources: sources[p.productId], version: versions[p.productId] ?? '' }));
    if (!jobs.length) return;

    this.building.set(true);
    jobs.forEach((j) => this.setStatus(j.productId, 'queued'));
    try {
      const summary = await this.tauri.buildProducts(jobs, this.outputDir());
      const msg =
        summary.failed === 0
          ? `Built ${summary.succeeded} installer${summary.succeeded === 1 ? '' : 's'}`
          : `Built ${summary.succeeded}, failed ${summary.failed} — hover the red icons for details`;
      this.snack.open(msg, 'Open folder', { duration: 8000 }).onAction().subscribe(() => this.openOutput());
    } catch (e) {
      jobs.forEach((j) => {
        if (this.statuses()[j.productId]?.status === 'queued') this.setStatus(j.productId, 'idle');
      });
      this.snack.open(String(e), 'Close', { duration: 8000 });
    } finally {
      this.building.set(false);
    }
  }
}
