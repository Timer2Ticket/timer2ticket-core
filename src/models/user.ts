import { ObjectId } from "mongodb";
import { JobDefinition } from "./job_definition";
import { Mapping } from "./mapping/mapping";
import { ServiceDefinition } from "./service_definition/service_definition";
import { UserConfig } from "./user_config";

export class User {
  _id!: string | ObjectId;
  username!: string;
  passwordHash!: string;
  registrated!: Date;
  status!: string;
  config!: UserConfig;
  configSyncJobDefinition!: JobDefinition;
  timeEntrySyncJobDefinition!: JobDefinition;
  serviceDefinitions: ServiceDefinition[] = [];
  mappings: Mapping[] = [];
}