/**
 * Point d'entrée des modèles de véhicules pour le rendu.
 *
 * La construction pure est dans `models/vehicles.ts` ; ce module expose le
 * cache utilisé par `VehicleLayer` et le choix d'archétype par instance.
 */

import { ModelLibrary } from './models/modelLibrary';
import {
  buildVehicleModel,
  type VehicleModelDefinition,
  type VehicleVariant,
} from './models/vehicles';

export {
  VEHICLE_VARIANTS,
  buildVehicleModel,
  buildVehicleModels,
  disposeVehicleModels,
  vehicleVariantFor,
  vehicleVariantFor as variantFor,
} from './models/vehicles';
export type { VehicleModelDefinition, VehicleSize, VehicleVariant } from './models/vehicles';
export { ModelLibrary } from './models/modelLibrary';
export type { LibraryStats } from './models/modelLibrary';

export type VehicleModelLibrary = ModelLibrary<VehicleVariant, VehicleModelDefinition>;

/** Cache de modèles, construit à la demande et libérable. */
export function createVehicleModelLibrary(): VehicleModelLibrary {
  return new ModelLibrary<VehicleVariant, VehicleModelDefinition>(buildVehicleModel);
}
