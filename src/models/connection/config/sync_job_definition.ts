export class SyncJobDefinition {
  // cron format: https://github.com/kelektiv/node-cron
  schedule!: string;
  lastJobTime!: number | null;
  // status: 'SUCCESS' | 'ERROR' | 'IN_PROGRESS' | null;
  status!: string | null;

  everyHour!: boolean;
  selectionOfDays!: number[];
  syncTime!: string;
}