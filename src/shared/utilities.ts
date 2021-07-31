export class Utilities {
  static getOnlyDateString(date: Date): string {
    return date.toISOString().substring(0, 10);
  }

  /**
   * Returns negative if date1 is before date2, positive if date1 is after date2, zero if date1 === date2 (exact match)
   * @param date1 
   * @param date2 
   */
  static compare(date1: Date, date2: Date): number {
    return date1.getTime() - date2.getTime();
  }
}