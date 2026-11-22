// Phone profiles: the size of the phone and where its main lens is. The printed dock is the same for
// every phone; a profile lets the software place the camera correctly in it (simulator, 3D view, rig
// check) and keeps each phone's calibrations apart.
//
// How to measure: phone upright (portrait), looking at its BACK, camera module at the top left.
// camFromTop / camFromLeft = centre of the main lens from the top edge / from the left edge, in mm.
// In the dock the phone goes in landscape with that corner at the fixed jaw, on the bottom edge, so
// camFromTop becomes the distance from the fixed jaw and camFromLeft the height above the rail.

export interface PhoneProfile {
  id: string;
  name: string;
  /** mm, including the case you will use */
  length: number;
  width: number;
  thickness: number;
  camFromTop: number;
  camFromLeft: number;
  /** true until measured on the real phone */
  provisional: boolean;
  note?: string;
}

export const PHONES: PhoneProfile[] = [
  {
    id: "iphone-15",
    name: "iPhone 15",
    length: 147.6,
    width: 71.6,
    thickness: 7.8,
    camFromTop: 14,
    camFromLeft: 14,
    provisional: true,
    note: "size from the spec sheet; the main lens position is approximate: measure it (the tip calibration measures the real mount anyway)",
  },
  {
    id: "redmi-note-13",
    name: "Redmi Note 13",
    length: 162.2,
    width: 75.4,
    thickness: 8.0,
    camFromTop: 15,
    camFromLeft: 14,
    provisional: true,
    note: "the reference the dock was designed for; lens position approximate",
  },
  {
    id: "redmi-15",
    name: "Redmi 15",
    length: 169.5,
    width: 80.5,
    thickness: 8.4,
    camFromTop: 17,
    camFromLeft: 16,
    provisional: true,
    note: "provisional values: measure the phone (with its case) and the lens, then update this profile",
  },
];

export const DEFAULT_PHONE_ID = "iphone-15";

export function phoneById(id: string | null | undefined): PhoneProfile {
  return PHONES.find((p) => p.id === id) ?? PHONES.find((p) => p.id === DEFAULT_PHONE_ID)!;
}

/** Problems with a profile against the dock's rail (empty = fits). */
export function phoneFits(p: PhoneProfile, rail: { phoneLength: readonly number[]; phoneThicknessMax: number }): string[] {
  const e: string[] = [];
  if (p.length < rail.phoneLength[0] || p.length > rail.phoneLength[1]) e.push(`length ${p.length} mm is outside ${rail.phoneLength[0]}-${rail.phoneLength[1]} mm`);
  if (p.thickness > rail.phoneThicknessMax) e.push(`thickness ${p.thickness} mm is over ${rail.phoneThicknessMax} mm`);
  if (!(p.camFromTop > 0 && p.camFromTop < p.length / 2)) e.push("camFromTop must be on the camera half of the phone");
  if (!(p.camFromLeft > 0 && p.camFromLeft < p.width)) e.push("camFromLeft must be within the phone's width");
  return e;
}
