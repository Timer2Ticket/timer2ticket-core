export class ProjectMapping {
    firstServiceProjectId!: number | string
    secondServiceProjectId!: number | string

    constructor(firstServiceProjectId: number | string, secondServiceProjectId: number | string) {
        this.firstServiceProjectId = firstServiceProjectId
        this.secondServiceProjectId = secondServiceProjectId
    }
}