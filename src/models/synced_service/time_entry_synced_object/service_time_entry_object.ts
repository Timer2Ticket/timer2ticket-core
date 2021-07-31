export class ServiceTimeEntryObject {
  id: number | string;
  service: string;
  isOrigin: boolean;

  constructor(id: number | string, service: string, isOrigin: boolean) {
    this.id = id;
    this.service = service;
    this.isOrigin = isOrigin;
  }
}