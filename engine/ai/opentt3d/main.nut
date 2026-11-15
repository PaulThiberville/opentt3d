/*
 * OpenTT3D - IA minimale : une ligne de bus entre deux villes.
 *
 * Déroulé (exécuté au premier tick de l'IA) :
 *  1. choisit la paire de villes la plus proche (identifiants croissants à
 *     distance égale) ;
 *  2. pose une gare routière de chaque côté, sur un terrain dégagé ;
 *  3. relie les deux entrées par une route en L (deux orientations essayées) ;
 *  4. construit un dépôt adjacent à la première gare et achète deux bus ;
 *  5. leur donne l'ordre gare A -> gare B et les met en route.
 *
 * Si la route échoue (eau, industrie, relief), les gares restent en place et
 * un bus est tout de même acheté : l'entreprise IA possède alors des
 * infrastructures visibles dans le snapshot.
 */

class OpenTT3D extends AIController {
	static MAX_LINK_LENGTH = 80;

	/**
	 * Vrai dès que la construction initiale a été tentée. Persisté par
	 * Save()/Load() : sans cela, un chargement de partie relancerait Start()
	 * et l'IA construirait une seconde ligne sur l'infrastructure existante
	 * (divergence de hash après un resync, #61/#38).
	 */
	built = false;

	function Start()
	{
		if (!this.built) {
			try {
				if (!this.BuildFirstLink()) {
					AILog.Warning("OpenTT3D : aucune liaison construite");
				}
			} catch (error) {
				AILog.Error("OpenTT3D : " + error);
			}
			this.built = true;
		}

		/* La ligne vit toute seule : on garde le script en vie en dormant. */
		while (true) AIController.Sleep(1000);
	}

	function Save()
	{
		return { built = this.built };
	}

	function Load(version, data)
	{
		this.built = (data.built == true);
	}

	/* --------------------------------------------------------------------- */
	/*  Sélection des villes et des emplacements                             */
	/* --------------------------------------------------------------------- */

	function BuildFirstLink()
	{
		/* Sans cela, les préconditions de construction routière échouent
		 * (ERR_PRECONDITION_FAILED) : le type de route courant est invalide. */
		AIRoad.SetCurrentRoadType(AIRoad.ROADTYPE_ROAD);

		local towns = this.TownIds();
		local pairs = this.TownPairs(towns);

		/* Plusieurs paires sont essayées : deux IA lancées sur la même graine
		 * visent d'abord la même liaison, et la seconde doit pouvoir se
		 * rabattre sur un autre couple de villes. */
		local site_a = null;
		local site_b = null;
		local station_a = -1;
		local station_b = -1;
		foreach (pair in pairs) {
			local location_a = AITown.GetLocation(pair[0]);
			local location_b = AITown.GetLocation(pair[1]);
			site_a = this.FindStationSite(location_a, location_b);
			if (site_a == null) continue;
			station_a = this.BuildStation(site_a);
			if (station_a == -1) continue;

			site_b = this.FindStationSite(location_b, location_a);
			if (site_b == null) continue;
			station_b = this.BuildStation(site_b);
			if (station_b == -1) continue;
			break;
		}
		if (station_a == -1) return false;

		local connected = false;
		if (station_b != -1) {
			connected = this.Connect(site_a.front, site_b.front, true);
			if (!connected) connected = this.Connect(site_a.front, site_b.front, false);
			if (!connected) {
				AILog.Warning("OpenTT3D : route impossible entre les gares, bus limité au dépôt");
			}
		}

		local depot = this.BuildDepot(site_a.front);
		if (depot == -1 && station_b != -1) depot = this.BuildDepot(site_b.front);
		if (depot == -1) return true; // les gares suffisent à peupler le monde

		local buses = this.BuyBuses(depot, station_a, station_b);
		AILog.Info("OpenTT3D : " + buses + " bus, route " + (connected ? "connectée" : "locale"));
		return true;
	}

	/** Identifiants de villes, triés par population décroissante (id à égalité). */
	function TownIds()
	{
		local ids = [];
		local list = AITownList();
		foreach (town, _ in list) ids.append(town);

		/* Tri par population décroissante, identifiant croissant à égalité
		 * (tri d'insertion : aucune dépendance à la stabilité de AIList/Sort). */
		for (local i = 1; i < ids.len(); i++) {
			local current = ids[i];
			local j = i - 1;
			while (j >= 0 && this.CompareTown(ids[j], current) > 0) {
				ids[j + 1] = ids[j];
				j--;
			}
			ids[j + 1] = current;
		}

		/* On ne considère que les villes les plus peuplées : les petites
		 * bourgades isolées n'ont pas de quoi rentabiliser une ligne. */
		local kept = [];
		for (local i = 0; i < ids.len() && i < 8; i++) kept.append(ids[i]);
		return kept.len() > 0 ? kept : ids;
	}

	function CompareTown(a, b)
	{
		local population_a = AITown.GetPopulation(a);
		local population_b = AITown.GetPopulation(b);
		if (population_a != population_b) return population_b - population_a;
		return a - b;
	}

	/** Paires de villes triées par distance croissante (identifiants à égalité). */
	function TownPairs(towns)
	{
		local pairs = [];
		for (local i = 0; i < towns.len(); i++) {
			for (local j = i + 1; j < towns.len(); j++) {
				local distance = AITown.GetDistanceManhattanToTile(
						towns[i], AITown.GetLocation(towns[j]));
				if (distance <= 8 || distance > OpenTT3D.MAX_LINK_LENGTH) continue;
				pairs.append([distance, towns[i], towns[j]]);
			}
		}

		for (local i = 1; i < pairs.len(); i++) {
			local current = pairs[i];
			local j = i - 1;
			while (j >= 0 && this.ComparePair(pairs[j], current) > 0) {
				pairs[j + 1] = pairs[j];
				j--;
			}
			pairs[j + 1] = current;
		}

		/* 12 essais suffisent largement sur les cartes 128×128..512×512. */
		local kept = [];
		for (local i = 0; i < pairs.len() && i < 12; i++) kept.append(pairs[i]);
		return kept;
	}

	function ComparePair(a, b)
	{
		if (a[0] != b[0]) return a[0] - b[0];
		if (a[1] != b[1]) return a[1] - b[1];
		return a[2] - b[2];
	}

	/**
	 * Cherche une case constructible à 4..15 tuiles d'une ville, du côté de
	 * l'autre ville, avec une case d'entrée adjacente libre.
	 */
	function FindStationSite(town_tile, other_tile)
	{
		local cx = AIMap.GetTileX(town_tile);
		local cy = AIMap.GetTileY(town_tile);
		local ox = AIMap.GetTileX(other_tile);
		local oy = AIMap.GetTileY(other_tile);

		local dx = ox - cx;
		local dy = oy - cy;
		local sx = dx > 0 ? 1 : (dx < 0 ? -1 : 0);
		local sy = dy > 0 ? 1 : (dy < 0 ? -1 : 0);
		if (sx == 0 && sy == 0) sx = 1;
		/* Axe dominant : la gare sort de la ville en direction de l'autre. */
		if (this.Abs(dx) >= this.Abs(dy)) sy = 0;
		else sx = 0;

		local radii = [5, 7, 9, 11, 13, 15, 4, 6, 8, 10, 12, 14];
		local offsets = [[0, 0], [0, 1], [0, -1], [1, 0], [-1, 0],
				[1, 1], [-1, 1], [1, -1], [-1, -1], [0, 2], [0, -2], [2, 0], [-2, 0]];

		/* Décalage déterministe par entreprise : deux IA ne visent pas la
		 * même case de gare au même moment. */
		local self_id = AICompany.ResolveCompanyID(AICompany.COMPANY_SELF);
		local offset_shift = self_id * 3;
		local radius_shift = self_id % radii.len();

		for (local r = 0; r < radii.len(); r++) {
			local radius = radii[(r + radius_shift) % radii.len()];
			for (local o = 0; o < offsets.len(); o++) {
				local offset = offsets[(o + offset_shift) % offsets.len()];
				local x = cx + sx * radius + offset[0];
				local y = cy + sy * radius + offset[1];
				local site = this.MakeStationSite(x, y, sx, sy);
				if (site != null) return site;
			}
		}
		return null;
	}

	function MakeStationSite(x, y, sx, sy)
	{
		if (!this.InMap(x, y)) return null;
		local tile = AIMap.GetTileIndex(x, y);
		if (!this.CanBuildOn(tile)) return null;

		local directions = [];
		if (sx != 0) directions.append([sx, 0]);
		if (sy != 0) directions.append([0, sy]);
		directions.append([0, 1]);
		directions.append([1, 0]);
		directions.append([0, -1]);
		directions.append([-1, 0]);

		foreach (direction in directions) {
			local fx = x + direction[0];
			local fy = y + direction[1];
			if (!this.InMap(fx, fy)) continue;
			local front = AIMap.GetTileIndex(fx, fy);
			if (!this.CanBuildOn(front)) continue;
			return { tile = tile, front = front };
		}
		return null;
	}

	/* --------------------------------------------------------------------- */
	/*  Construction                                                         */
	/* --------------------------------------------------------------------- */

	function BuildStation(site)
	{
		if (!this.PrepareTile(site.tile)) return -1;
		if (!this.PrepareTile(site.front)) return -1;
		if (!AIRoad.BuildRoadStation(site.tile, site.front, AIRoad.ROADVEHTYPE_BUS, AIStation.STATION_NEW)) {
			AILog.Warning("OpenTT3D : gare refusée (" + AIError.GetLastErrorString() + ")");
			return -1;
		}
		return AIStation.GetStationID(site.tile);
	}

	/** Relie deux entrées de gares par une route en L (une seule orientation). */
	function Connect(front_a, front_b, horizontal_first)
	{
		local ax = AIMap.GetTileX(front_a);
		local ay = AIMap.GetTileY(front_a);
		local bx = AIMap.GetTileX(front_b);
		local by = AIMap.GetTileY(front_b);

		local path = [front_a];
		if (horizontal_first) {
			this.AppendHorizontal(path, ax, bx, ay);
			this.AppendVertical(path, bx, ay, by);
		} else {
			this.AppendVertical(path, ax, ay, by);
			this.AppendHorizontal(path, ax, bx, by);
		}

		if (path.len() > OpenTT3D.MAX_LINK_LENGTH + 2) return false;

		foreach (tile in path) {
			if (AITile.IsWaterTile(tile) || AITile.IsCoastTile(tile)) return false;
			if (AITile.IsStationTile(tile)) return false;
			if (!AIRoad.IsRoadTile(tile) && !this.PrepareTile(tile)) return false;
		}

		for (local i = 1; i < path.len(); i++) {
			if (!this.EnsureRoad(path[i - 1], path[i])) return false;
		}
		return AIRoad.IsRoadTile(front_a) && AIRoad.IsRoadTile(front_b);
	}

	/** Ajoute les cases de (from_x, y) à (to_x, y), origine exclue. */
	function AppendHorizontal(path, from_x, to_x, y)
	{
		if (from_x == to_x) return;
		local step = to_x > from_x ? 1 : -1;
		for (local x = from_x + step; ; x += step) {
			path.append(AIMap.GetTileIndex(x, y));
			if (x == to_x) break;
		}
	}

	/** Ajoute les cases de (x, from_y) à (x, to_y), origine exclue. */
	function AppendVertical(path, x, from_y, to_y)
	{
		if (from_y == to_y) return;
		local step = to_y > from_y ? 1 : -1;
		for (local y = from_y + step; ; y += step) {
			path.append(AIMap.GetTileIndex(x, y));
			if (y == to_y) break;
		}
	}

	/** Construit la route entre deux cases adjacentes, dans un sens ou l'autre. */
	function EnsureRoad(a, b)
	{
		if (AIRoad.IsRoadTile(a) && AIRoad.IsRoadTile(b)) return true;
		if (AIRoad.BuildRoad(a, b)) return true;
		if (AIRoad.IsRoadTile(a) && AIRoad.IsRoadTile(b)) return true;
		if (AIRoad.BuildRoad(b, a)) return true;
		return AIRoad.IsRoadTile(a) && AIRoad.IsRoadTile(b);
	}

	function BuildDepot(front_tile)
	{
		local fx = AIMap.GetTileX(front_tile);
		local fy = AIMap.GetTileY(front_tile);
		/* Axes uniquement : BuildRoadDepot exige une case d'entrée alignée. */
		local directions = [[0, 1], [1, 0], [0, -1], [-1, 0], [0, 2], [2, 0], [0, -2], [-2, 0]];

		foreach (direction in directions) {
			local x = fx + direction[0];
			local y = fy + direction[1];
			if (!this.InMap(x, y)) continue;
			local tile = AIMap.GetTileIndex(x, y);
			if (AITile.IsStationTile(tile) || AIRoad.IsRoadTile(tile)) continue;
			if (!this.CanBuildOn(tile)) continue;
			if (!this.PrepareTile(tile)) continue;
			if (AIRoad.BuildRoadDepot(tile, front_tile)) return tile;
		}
		return -1;
	}

	/** Meilleur moteur routier pour passagers disponible à la date courante. */
	function FindBusEngine()
	{
		local engines = AIEngineList(AIVehicle.VT_ROAD);
		engines.Valuate(AIEngine.CanRunOnRoad, AIRoad.ROADTYPE_ROAD);
		engines.KeepValue(1);
		engines.Valuate(AIEngine.IsBuildable);
		engines.KeepValue(1);

		local best = -1;
		local best_capacity = -1;
		foreach (engine, _ in engines) {
			if (AICargo.GetTownEffect(AIEngine.GetCargoType(engine)) != AICargo.TE_PASSENGERS) continue;
			local capacity = AIEngine.GetCapacity(engine);
			if (capacity > best_capacity || (capacity == best_capacity && engine < best)) {
				best = engine;
				best_capacity = capacity;
			}
		}
		return best;
	}

	function BuyBuses(depot, station_a, station_b)
	{
		local engine = this.FindBusEngine();
		if (engine == -1) return 0;

		local built = 0;
		for (local i = 0; i < 2; i++) {
			local vehicle = AIVehicle.BuildVehicle(depot, engine);
			if (!AIVehicle.IsValidVehicle(vehicle)) break;

			AIOrder.AppendOrder(vehicle, AIStation.GetLocation(station_a), AIOrder.OF_NONE);
			if (station_b != -1) {
				AIOrder.AppendOrder(vehicle, AIStation.GetLocation(station_b), AIOrder.OF_NONE);
			}
			AIVehicle.StartStopVehicle(vehicle);
			built++;
		}
		return built;
	}

	/* --------------------------------------------------------------------- */
	/*  Utilitaires                                                          */
	/* --------------------------------------------------------------------- */

	function InMap(x, y)
	{
		return x >= 0 && y >= 0 && x < AIMap.GetMapSizeX() && y < AIMap.GetMapSizeY();
	}

	function Abs(value)
	{
		return value < 0 ? -value : value;
	}

	/**
	 * Une case peut-elle être utilisée ? Seules les cases déjà plates sont
	 * retenues : le terraformage d'une case isolée n'est pas possible avec
	 * `LevelTiles` (qui nivele vers la hauteur de la case de départ) et
	 * `RaiseTile`/`LowerTile` coûterait trop cher pour une IA de démonstration.
	 */
	function CanBuildOn(tile)
	{
		if (AITile.IsWaterTile(tile) || AITile.IsCoastTile(tile)) return false;
		if (AITile.IsStationTile(tile)) return false;
		if (AITile.GetSlope(tile) != AITile.SLOPE_FLAT) return false;
		if (AITile.IsBuildable(tile)) return true;
		return AITile.HasTreeOnTile(tile) || AITile.IsHouseTile(tile) ||
				AITile.IsFarmTile(tile) || AITile.IsRockTile(tile) || AITile.IsRoughTile(tile);
	}

	/** Dégage une case plate ; false si c'est impossible. */
	function PrepareTile(tile)
	{
		if (AIRoad.IsRoadTile(tile)) return true;
		if (AITile.GetSlope(tile) != AITile.SLOPE_FLAT) return false;
		if (!AITile.IsBuildable(tile)) {
			if (!AITile.DemolishTile(tile)) return false;
			if (!AITile.IsBuildable(tile)) return false;
		}
		return true;
	}
}
