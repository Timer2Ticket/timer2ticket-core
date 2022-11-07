import {Dictionary} from "typescript-collections";

export class ServiceObject {
  id: number | string;
  name: string;
  type: string;

  static archiveLimits: { [key: string]: number } = {
    "redmine": 36500,
    "toggl": 60
  };

  constructor(id: number | string, name: string, type: string) {
    this.id = id;
    this.name = name;
    this.type = type;
  }
}