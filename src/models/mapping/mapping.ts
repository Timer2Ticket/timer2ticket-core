import { MappingsObject } from "./mappings_object";

export class Mapping {
  primaryObjectId!: number | string;
  primaryObjectType?: string;
  name!: string;
  mappingsObjects: MappingsObject[] = [];
  markedToDelete?: Date;
}