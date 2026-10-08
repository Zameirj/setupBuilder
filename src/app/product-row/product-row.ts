import { Component, computed, input, output } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatIconModule } from '@angular/material/icon';
import { MatMenuModule } from '@angular/material/menu';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatTooltipModule } from '@angular/material/tooltip';
import { BuildStatus, Product } from '../tauri.service';

@Component({
  selector: 'app-product-row',
  imports: [
    FormsModule,
    MatButtonModule,
    MatCheckboxModule,
    MatIconModule,
    MatMenuModule,
    MatProgressSpinnerModule,
    MatTooltipModule,
  ],
  templateUrl: './product-row.html',
  styleUrl: './product-row.scss',
})
export class ProductRow {
  readonly product = input.required<Product>();
  readonly selected = input(false);
  readonly sources = input<string[]>([]);
  readonly version = input('');
  readonly status = input<BuildStatus>('idle');
  readonly message = input('');
  readonly disabled = input(false);

  readonly selectedChange = output<boolean>();
  readonly browseFiles = output<void>();
  readonly browseFolder = output<void>();
  readonly clearSource = output<void>();
  readonly versionChange = output<string>();
  readonly copyPassword = output<void>();

  readonly isChild = computed(() => !!this.product().parentProductId);
  readonly hasSources = computed(() => this.sources().length > 0);
  readonly sourceLabel = computed(() => {
    const s = this.sources();
    if (s.length === 1) return s[0];
    const name = (p: string) => p.slice(p.lastIndexOf('\\') + 1);
    return `${s.length} items: ${s.map(name).join(', ')}`;
  });
  readonly sourceTooltip = computed(() => this.sources().join('\n'));
}
