export class ServiceObject {
  id: number | string;
  name: string;
  type: string;

  constructor(id: number | string, name: string, type: string) {
    this.id = id;
    this.name = name;
    this.type = type;
  }
}