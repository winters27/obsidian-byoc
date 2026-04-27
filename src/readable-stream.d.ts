declare module "readable-stream" {
  export class Readable {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-function-type -- Overriding generic standard NodeJS event listener
      on(event: string, listener: Function): this;
  }
}
