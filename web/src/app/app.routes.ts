import { Routes } from '@angular/router';

export const routes: Routes = [
  { path: '', loadComponent: () => import('./pages/home').then((m) => m.Home) },
  { path: 'room/:label', loadComponent: () => import('./pages/room-page').then((m) => m.RoomPage) },
  { path: '**', redirectTo: '' },
];
