declare module "js-aruco2" {
  export namespace AR {
    interface Point {
      x: number;
      y: number;
    }
    class Marker {
      id: number;
      corners: Point[];
      hammingDistance: number;
    }
    class Detector {
      constructor(config?: { dictionaryName?: string; maxHammingDistance?: number });
      detect(image: { width: number; height: number; data: Uint8ClampedArray }): Marker[];
    }
    class Dictionary {
      constructor(name: string);
      codeList: string[];
      markSize: number;
      generateSVG(id: number): string;
    }
  }
}
