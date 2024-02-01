export class ServiceObject {
  id: number | string;
  name: string;
  type: string;
  projectId: number | string | null
  syncCustomFieldValue: number | string | null

  constructor(id: number | string, name: string, type: string, projectId: number | string | null = null, syncCustomFieldValue: number | string | null = null) {
    this.id = id;
    this.name = name;
    this.type = type;
    this.projectId = projectId
    this.syncCustomFieldValue = syncCustomFieldValue
  }
}