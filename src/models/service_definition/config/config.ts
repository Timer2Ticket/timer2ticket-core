export class Config {
  /**
   * shared
   */
  userId!: number;
  /**
   * below Toggl specific
   */
  workspace?: Workspace | null;
  /**
   * below Redmine specific
   */
  apiPoint?: string | null;

  defaultTimeEntryActivity?: DefaultTimeEntryActivity | null;
}

class Workspace {
  id!: string | number;
  name!: string;
}

class DefaultTimeEntryActivity {
  id!: string | number;
  name!: string;
}