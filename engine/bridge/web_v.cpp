/*
 * OpenTT3D - pilote vidéo "web" pour la compilation WebAssembly headless.
 *
 * Ce pilote ne dessine rien et ne possède pas de GUI : il sert uniquement à
 * faire croire à OpenTTD qu'un écran existe. `MainLoop()` retourne
 * immédiatement ; c'est le pont C++ (`ottd_bridge.cpp`) qui pompe la boucle
 * avec `GameLoop()` / `InputLoop()` / `UpdateWindows()` à la demande.
 *
 * Inspiré de `src/video/null_v.cpp` et `src/video/dedicated_v.cpp` (GPL v2).
 */

#include "stdafx.h"

#include "blitter/factory.hpp"
#include "gfx_func.h"
#include "video/video_driver.hpp"

#include "safeguards.h"

/** Pilote vidéo sans rendu, piloté tick par tick depuis JavaScript. */
class VideoDriver_Web : public VideoDriver {
public:
	std::optional<std::string_view> Start(const StringList &) override
	{
		this->UpdateAutoResolution();

		_screen.width  = _screen.pitch = _cur_resolution.width;
		_screen.height = _cur_resolution.height;
		/* Aucun buffer : aucun rendu ne sera jamais demandé. */
		_screen.dst_ptr = nullptr;
		ScreenSizeChanged();

		/* Le blitter null est le seul compatible avec l'absence de surface. */
		BlitterFactory::SelectBlitter("null");

		Debug(driver, 1, "OpenTT3D: pilote vidéo web initialisé ({}x{})", _screen.width, _screen.height);
		return std::nullopt;
	}

	void Stop() override {}

	void MakeDirty(int, int, int, int) override {}

	/** Ne bloque jamais : le pont appelle la boucle de jeu explicitement. */
	void MainLoop() override {}

	bool ChangeResolution(int, int) override { return false; }

	bool ToggleFullscreen(bool) override { return false; }

	std::string_view GetName() const override { return "web"; }

	bool HasGUI() const override { return false; }
};

/** Fabrique du pilote vidéo web. */
class FVideoDriver_Web : public DriverFactoryBase {
public:
	FVideoDriver_Web() : DriverFactoryBase(Driver::DT_VIDEO, 0, "web", "OpenTT3D Headless Web Driver") {}
	std::unique_ptr<Driver> CreateInstance() const override { return std::make_unique<VideoDriver_Web>(); }
};

static FVideoDriver_Web iFVideoDriver_Web;
