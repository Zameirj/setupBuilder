import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MAT_DIALOG_DATA, MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { Settings } from '../tauri.service';

@Component({
  selector: 'app-settings-dialog',
  imports: [FormsModule, MatDialogModule, MatFormFieldModule, MatInputModule, MatButtonModule, MatIconModule],
  template: `
    <h2 mat-dialog-title>Settings</h2>
    <mat-dialog-content class="settings">
      <mat-form-field appearance="outline">
        <mat-label>API URL</mat-label>
        <input matInput [(ngModel)]="apiUrl" name="apiUrl" required />
      </mat-form-field>
      <mat-form-field appearance="outline">
        <mat-label>API key (x-api-key)</mat-label>
        <input matInput [type]="showKey() ? 'text' : 'password'" [(ngModel)]="apiKey" name="apiKey" required />
        <button mat-icon-button matSuffix type="button" (click)="showKey.set(!showKey())" [attr.aria-label]="showKey() ? 'Hide key' : 'Show key'">
          <mat-icon>{{ showKey() ? 'visibility_off' : 'visibility' }}</mat-icon>
        </button>
        <mat-hint>Stored locally in the app's config folder.</mat-hint>
      </mat-form-field>
    </mat-dialog-content>
    <mat-dialog-actions align="end">
      <button mat-button mat-dialog-close>Cancel</button>
      <button mat-flat-button [disabled]="!apiKey.trim() || !apiUrl.trim()" (click)="save()">Save</button>
    </mat-dialog-actions>
  `,
  styles: `
    .settings { display: flex; flex-direction: column; gap: 8px; min-width: 480px; padding-top: 8px; }
  `,
})
export class SettingsDialog {
  private readonly ref = inject(MatDialogRef<SettingsDialog, Settings>);
  private readonly data = inject<Settings>(MAT_DIALOG_DATA);

  apiUrl = this.data.apiUrl;
  apiKey = this.data.apiKey;
  readonly showKey = signal(false);

  save(): void {
    this.ref.close({ apiUrl: this.apiUrl.trim(), apiKey: this.apiKey.trim() });
  }
}
