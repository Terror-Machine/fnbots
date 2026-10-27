#!/usr/bin/env bash
# ─── Info ───────────────────────────────────────
# Created with ❤️ and 💦 By FN
# Follow https://github.com/Terror-Machine
# Feel Free To Use
# ─── Info update.sh ─────────────────────────────

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

print_success() { echo -e "${GREEN}✅ $1${NC}"; }
print_error() { echo -e "${RED}❌ $1${NC}"; }
print_warning() { echo -e "${YELLOW}⚠️  $1${NC}"; }
print_info() { echo -e "${BLUE}ℹ️  $1${NC}"; }
print_step() { echo -e "${BLUE}🔧 $1${NC}"; }

setup_privileges() {
    if [ "$EUID" -eq 0 ]; then
        print_success "Menjalankan script sebagai root"
        SUDO_CMD=""
        ORIGINAL_USER="${SUDO_USER:-root}"
    elif command -v sudo >/dev/null 2>&1; then
        if sudo -n true 2>/dev/null; then
            print_success "Menjalankan script dengan sudo passwordless"
            SUDO_CMD="sudo"
            ORIGINAL_USER="$USER"
        else
            print_info "Memerlukan password sudo untuk melanjutkan..."
            if sudo -v; then
                print_success "Akses sudo berhasil diverifikasi"
                SUDO_CMD="sudo"
                ORIGINAL_USER="$USER"
            else
                print_error "Gagal mendapatkan akses sudo"
                exit 1
            fi
        fi
    else
        print_error "Script harus dijalankan sebagai root atau user dengan sudo"
        exit 1
    fi
}

check_venv() {
    print_step "Memeriksa virtual environment..."
    
    if [ ! -d "venv" ]; then
        print_error "Virtual environment 'venv' tidak ditemukan!"
        print_info "Pastikan Anda sudah menjalankan setup.sh terlebih dahulu"
        print_info "Atau buat virtual environment dengan: python3.12 -m venv venv"
        exit 1
    fi
    
    if [ ! -f "venv/bin/pip" ]; then
        print_error "Pip tidak ditemukan di virtual environment!"
        print_info "Virtual environment mungkin rusak, coba buat ulang dengan setup.sh"
        exit 1
    fi
    
    print_success "Virtual environment ditemukan dan valid"
}

upgrade_pip_tools() {
    print_step "Mengupgrade pip, setuptools, dan wheel..."
    
    if venv/bin/pip install --upgrade pip setuptools wheel; then
        print_success "Pip tools berhasil diupgrade"
    else
        print_error "Gagal mengupgrade pip tools"
        exit 1
    fi
}

update_python_packages() {
    print_step "Mengupdate package Python yang penting..."
    
    PACKAGES=(
        "yt-dlp"
        "google-generativeai"
        "python-dotenv"
        "ffmpeg-python"
        "g4f[all]"
        "rembg"
        "Pillow"
    )
    FAILED=()
    for pkg in "${PACKAGES[@]}"; do
        print_info "Menginstall $pkg ..."
        if venv/bin/pip install --upgrade "$pkg"; then
            print_success "$pkg berhasil"
        else
            print_warning "$pkg gagal"
            FAILED+=("$pkg")
        fi
    done
    # sticker-convert: jangan compile dari source (av butuh ffmpeg 7)
    print_info "Menginstall sticker-convert (binary only) ..."
    if venv/bin/pip install --upgrade --only-binary=:all: sticker-convert; then
        print_success "sticker-convert berhasil"
    else
        print_warning "sticker-convert gagal"
        FAILED+=("sticker-convert")
    fi
    if [ ${#FAILED[@]} -eq 0 ]; then
        print_success "Semua package Python berhasil diupdate"
    else
        print_warning "Package yang gagal: ${FAILED[*]}"
    fi
}

update_ytdlp_from_github() {
    print_step "Mengupdate yt-dlp versi terbaru dari GitHub..."
    
    if venv/bin/pip install -U "yt-dlp @ git+https://github.com/yt-dlp/yt-dlp.git"; then
        print_success "yt-dlp dari GitHub berhasil diupdate"
    else
        print_warning "Gagal mengupdate yt-dlp dari GitHub, menggunakan versi PyPI"
    fi
}

update_from_requirements() {
    if [ -f "requirements.txt" ]; then
        print_step "Mengupdate package dari requirements.txt..."
        
        if venv/bin/pip install --upgrade -r requirements.txt; then
            print_success "Package dari requirements.txt berhasil diupdate"
        else
            print_warning "Beberapa package dari requirements.txt gagal diupdate"
        fi
    else
        print_info "requirements.txt tidak ditemukan, melewati update dari file"
    fi
}

show_installed_versions() {
    print_step "Menampilkan versi package yang terinstall..."
    echo ""
    echo "═══════════════════════════════════════════════════════════════"
    echo "📦 Versi Package Terinstall"
    echo "═══════════════════════════════════════════════════════════════"
    
    venv/bin/pip list | grep -E "(yt-dlp|google-generativeai|python-dotenv|ffmpeg-python|g4f|rembg|Pillow|sticker-convert|pip|setuptools|wheel)" || true
    
    echo "═══════════════════════════════════════════════════════════════"
    echo ""
}

cleanup_pip_cache() {
    print_step "Membersihkan cache pip..."
    
    if venv/bin/pip cache purge; then
        print_success "Cache pip berhasil dibersihkan"
    else
        print_warning "Gagal membersihkan cache pip"
    fi
}

fix_permissions() {
    print_step "Memperbaiki permissions folder..."
    
    if [ "$ORIGINAL_USER" != "root" ] && [ -n "$ORIGINAL_USER" ]; then
        $SUDO_CMD chown -R "$ORIGINAL_USER:$ORIGINAL_USER" .
        print_success "Permissions berhasil diperbaiki untuk user: $ORIGINAL_USER"
    fi
}

print_summary() {
    echo ""
    echo "═══════════════════════════════════════════════════════════════"
    print_success "UPDATE SELESAI!"
    echo "═══════════════════════════════════════════════════════════════"
    echo ""
    echo "🐍 Python Virtual Environment:"
    echo "   • Lokasi: $(pwd)/venv"
    echo "   • Pip:    $(venv/bin/pip --version | awk '{print $2}')"
    echo "   • Python: $(venv/bin/python --version | awk '{print $2}')"
    echo ""
    echo "💡 Langkah Selanjutnya:"
    echo "   • Aktifkan virtual environment:"
    echo "     $ source venv/bin/activate"
    echo ""
    echo "   • Untuk melihat semua package:"
    echo "     $ venv/bin/pip list"
    echo ""
    echo "   • Untuk mengupdate package spesifik:"
    echo "     $ venv/bin/pip install --upgrade <package-name>"
    echo ""
    echo "═══════════════════════════════════════════════════════════════"
}

main() {
    clear
    echo "═══════════════════════════════════════════════════════════════"
    echo "         Python Package Update Script"
    echo "═══════════════════════════════════════════════════════════════"
    echo ""
    
    setup_privileges
    echo ""
    
    check_venv
    echo ""
    
    print_info "Update akan dimulai dalam 3 detik..."
    print_warning "Tekan Ctrl+C untuk membatalkan"
    sleep 3
    echo ""
    
    upgrade_pip_tools
    echo ""
    
    update_python_packages
    echo ""
    
    update_ytdlp_from_github
    echo ""
    
    update_from_requirements
    echo ""
    
    show_installed_versions
    
    cleanup_pip_cache
    echo ""
    
    fix_permissions
    echo ""
    
    print_summary
}

main "$@"