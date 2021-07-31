export class MappingsObject {
  /**
   * Id of real object in the service
   */
  id: string | number;
  /**
   * Name of the object in the service
   */
  name: string;
  service: string;
  type: string;
  lastUpdated: number;

  constructor(id: string | number, name: string, service: string, type: string) {
    this.id = id;
    this.name = name;
    this.service = service;
    this.type = type;
    this.lastUpdated = Date.now();
  }
}